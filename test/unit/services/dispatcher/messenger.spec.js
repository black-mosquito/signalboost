import { expect } from 'chai'
import { describe, it, beforeEach, afterEach } from 'mocha'
import sinon from 'sinon'
import { times, values } from 'lodash'
import { languages } from '../../../../app/constants'
import { memberTypes } from '../../../../app/db/repositories/membership'
import signal from '../../../../app/services/signal'
import messageCountRepository from '../../../../app/db/repositories/messageCount'
import messenger, { messageTypes } from '../../../../app/services/dispatcher/messenger'
import messages from '../../../../app/services/dispatcher/strings/messages/EN'
import { statuses, commands } from '../../../../app/services/dispatcher/commands/constants'
import { genPhoneNumber } from '../../../support/factories/phoneNumber'
import { sdMessageOf } from '../../../../app/services/signal'
import { messagesIn } from '../../../../app/services/dispatcher/strings/messages'
import { defaultLanguage } from '../../../../app/config'
import channelRepository from '../../../../app/db/repositories/channel'
import { wait } from '../../../../app/services/util'
const {
  signal: { signupPhoneNumber, broadcastBatchSize },
} = require('../../../../app/config')

describe('messenger service', () => {
  const notifications = messagesIn(defaultLanguage).notifications
  const [db, sock] = [{}, { write: () => {} }]
  const channelPhoneNumber = genPhoneNumber()
  const subscriberPhoneNumbers = times(2, genPhoneNumber)
  const adminPhoneNumbers = times(4, genPhoneNumber)
  const channel = {
    name: 'foobar',
    phoneNumber: channelPhoneNumber,
    messageExpiryTime: 60,
    memberships: [
      {
        type: memberTypes.ADMIN,
        channelPhoneNumber,
        memberPhoneNumber: adminPhoneNumbers[0],
        language: languages.FR,
      },
      { type: memberTypes.ADMIN, channelPhoneNumber, memberPhoneNumber: adminPhoneNumbers[1] },
      { type: memberTypes.ADMIN, channelPhoneNumber, memberPhoneNumber: adminPhoneNumbers[2] },
      { type: memberTypes.ADMIN, channelPhoneNumber, memberPhoneNumber: adminPhoneNumbers[3] },
      {
        type: memberTypes.SUBSCRIBER,
        channelPhoneNumber,
        memberPhoneNumber: subscriberPhoneNumbers[0],
      },
      {
        type: memberTypes.SUBSCRIBER,
        channelPhoneNumber,
        memberPhoneNumber: subscriberPhoneNumbers[1],
      },
    ],
    messageCount: { broadcastIn: 42 },
  }
  const hotlineEnabledChannel = { ...channel, hotlineOn: true }
  const signupChannel = {
    name: 'SB_SIGNUP',
    phoneNumber: signupPhoneNumber,
    memberships: channel.memberships,
  }

  const attachments = [{ filename: 'some/path', width: 42, height: 42 }]
  const sdMessage = {
    type: 'send',
    messageBody: 'please help!',
    recipientNumber: genPhoneNumber(),
    attachments,
  }
  const adminSender = {
    phoneNumber: adminPhoneNumbers[0],
    type: memberTypes.ADMIN,
    language: languages.EN,
  }
  const subscriberSender = {
    phoneNumber: subscriberPhoneNumbers[0],
    type: memberTypes.SUBSCRIBER,
    language: languages.ES,
  }
  const randomSender = {
    phoneNumber: genPhoneNumber(),
    type: memberTypes.NONE,
    language: languages.EN,
  }

  const adminMemberships = channelRepository.getAdminMemberships(channel)

  describe('classifying a command result', () => {
    it('recognizes a broadcast message', () => {
      const msg = { command: 'foo', status: statuses.NOOP }
      const dispatchable = { channel, sender: adminSender }
      expect(messenger.parseMessageType(msg, dispatchable)).to.eql(messageTypes.BROADCAST_MESSAGE)
    })

    it('recognizes a hotline message from a subscriber', () => {
      const msg = { command: 'foo', status: statuses.NOOP }
      const dispatchable = { channel, sender: subscriberSender }
      expect(messenger.parseMessageType(msg, dispatchable)).to.eql(messageTypes.HOTLINE_MESSAGE)
    })

    it('recognizes a broadcast response from a random person', () => {
      const msg = { command: 'foo', status: statuses.NOOP }
      const dispatchable = { channel, sender: randomSender }
      expect(messenger.parseMessageType(msg, dispatchable)).to.eql(messageTypes.HOTLINE_MESSAGE)
    })

    it('recognizes a command result', () => {
      const msg = { command: 'JOIN', status: statuses.SUCCESS }
      const dispatchable = { channel, sender: randomSender }
      expect(messenger.parseMessageType(msg, dispatchable)).to.eql(messageTypes.COMMAND_RESULT)
    })
  })

  describe('dispatching a message', () => {
    let broadcastSpy,
      respondSpy,
      broadcastMessageStub,
      sendMessageStub,
      countCommandStub,
      countBroadcastStub,
      countHotlineStub,
      setExpirationStub

    beforeEach(() => {
      broadcastSpy = sinon.spy(messenger, 'broadcast')
      respondSpy = sinon.spy(messenger, 'respond')
      broadcastMessageStub = sinon.stub(signal, 'broadcastMessage').returns(Promise.resolve())
      sendMessageStub = sinon.stub(signal, 'sendMessage').returns(Promise.resolve())
      countCommandStub = sinon
        .stub(messageCountRepository, 'countCommand')
        .returns(Promise.resolve())
      countBroadcastStub = sinon
        .stub(messageCountRepository, 'countBroadcast')
        .returns(Promise.resolve())
      countHotlineStub = sinon
        .stub(messageCountRepository, 'countHotline')
        .returns(Promise.resolve())
      setExpirationStub = sinon.stub(signal, 'setExpiration').returns(Promise.resolve())
    })

    afterEach(() => {
      broadcastSpy.restore()
      respondSpy.restore()
      broadcastMessageStub.restore()
      sendMessageStub.restore()
      countCommandStub.restore()
      countBroadcastStub.restore()
      countHotlineStub.restore()
      setExpirationStub.restore()
    })

    describe('a broadcast message', () => {
      describe('when sender is a admin', () => {
        beforeEach(
          async () =>
            await messenger.dispatch({
              commandResult: {
                status: statuses.NOOP,
                messageBody: messages.notifications.noop,
                notifications: [],
              },
              dispatchable: { db, sock, channel, sender: adminSender, sdMessage },
            }),
        )
        it('does not respond to the sender', () => {
          expect(respondSpy.callCount).to.eql(0)
        })

        it('does not increment the command count for the channel', () => {
          expect(countCommandStub.callCount).to.eql(0)
        })

        it('broadcasts the message to all channel subscribers and admins in batches', () => {
          expect(broadcastMessageStub.getCall(0).args).to.eql([
            sock,
            [...adminPhoneNumbers, ...subscriberPhoneNumbers].splice(0, 2),
            { ...sdMessage, messageBody: '[foobar]\nplease help!' },
          ])

          expect(broadcastMessageStub.getCall(1).args).to.eql([
            sock,
            [...adminPhoneNumbers, ...subscriberPhoneNumbers].splice(2, 2),
            { ...sdMessage, messageBody: '[foobar]\nplease help!' },
          ])

          expect(broadcastMessageStub.getCall(2).args).to.eql([
            sock,
            [...adminPhoneNumbers, ...subscriberPhoneNumbers].splice(4, 2),
            { ...sdMessage, messageBody: '[foobar]\nplease help!' },
          ])
        })

        it('it increments the command count for the channel', () => {
          expect(countBroadcastStub.getCall(0).args).to.eql([db, channel])
        })

        it('attempts to broadcast in batches of broadcastBatchSize', async () => {
          expect(broadcastMessageStub.callCount).to.eql(
            [...adminPhoneNumbers, ...subscriberPhoneNumbers].length / broadcastBatchSize,
          )
        })
      })
    })

    describe('a hotline message', () => {
      describe('when sender is a subscriber', () => {
        describe('and hotline is disabled', () => {
          const sender = subscriberSender

          beforeEach(async () => {
            await messenger.dispatch({
              commandResult: {
                status: statuses.NOOP,
                messageBody: messages.notifications.noop,
                notifications: [],
              },
              dispatchable: { db, sock, channel, sender, sdMessage },
            })
          })

          it('does not broadcast a message', () => {
            expect(broadcastSpy.callCount).to.eql(0)
          })

          it('sends an error message to the message sender', () => {
            const response = messagesIn(sender.language).notifications.hotlineMessagesDisabled(true)

            expect(sendMessageStub.getCall(0).args).to.eql([
              sock,
              sender.phoneNumber,
              sdMessageOf(channel, response),
            ])
          })
        })

        describe('and hotline is enabled', () => {
          const sender = subscriberSender

          beforeEach(async () => {
            await messenger.dispatch({
              commandResult: {
                status: statuses.NOOP,
                messageBody: messages.notifications.noop,
                notifications: [],
              },
              dispatchable: { db, sock, channel: hotlineEnabledChannel, sender, sdMessage },
            })
          })

          it('forwards the message to channel admins with the header in the correct language', () => {
            adminMemberships.forEach((membership, index) => {
              const alert = messenger.addHeader({
                channel,
                sdMessage,
                messageType: messageTypes.HOTLINE_MESSAGE,
                language: membership.language,
              }).messageBody
              expect(sendMessageStub.getCall(index).args).to.eql([
                sock,
                membership.memberPhoneNumber,
                sdMessageOf(channel, alert),
              ])
            })
          })

          it('responds to sender with a hotline message notification in the correct language', () => {
            const response = messagesIn(sender.language).notifications.hotlineMessageSent(channel)
            expect(sendMessageStub.getCall(adminMemberships.length).args).to.eql([
              sock,
              sender.phoneNumber,
              sdMessageOf(channel, response),
            ])
          })

          it('counts the hotline message', () => {
            expect(countHotlineStub.callCount).to.eql(1)
          })
        })
      })

      describe('when sender is a random person', () => {
        const sender = randomSender

        describe('and hotline is enabled', () => {
          beforeEach(async () => {
            await messenger.dispatch({
              commandResult: { status: statuses.NOOP, messageBody: messages.notifications.noop },
              dispatchable: { db, sock, channel: hotlineEnabledChannel, sender, sdMessage },
            })
          })

          it('forwards the message to channel admins with the header in the correct language', () => {
            adminMemberships.forEach((membership, index) => {
              const alert = messenger.addHeader({
                channel,
                sdMessage,
                messageType: messageTypes.HOTLINE_MESSAGE,
                language: membership.language,
              }).messageBody

              expect(sendMessageStub.getCall(index).args).to.eql([
                sock,
                membership.memberPhoneNumber,
                sdMessageOf(channel, alert),
              ])
            })
          })

          it('responds to sender with a broadcast response notification', () => {
            const response = messagesIn(sender.language).notifications.hotlineMessageSent(channel)
            expect(sendMessageStub.getCall(adminMemberships.length).args).to.eql([
              sock,
              sender.phoneNumber,
              sdMessageOf(channel, response),
            ])
          })
        })
      })
    })

    describe('when message is a signup request', () => {
      const adminPhoneNumbers = channelRepository.getAdminPhoneNumbers(channel)

      beforeEach(async () => {
        const dispatchable = {
          db,
          sock,
          channel: signupChannel,
          sender: randomSender,
          sdMessage: sdMessageOf(signupChannel, 'gimme a channel'),
        }
        const commandResult = { status: commands.NOOP, message: '', notifications: [] }
        await messenger.dispatch({ dispatchable, commandResult })
      })

      it('responds to requester', () => {
        expect(sendMessageStub.getCall(0).args).to.eql([
          sock,
          randomSender.phoneNumber,
          sdMessageOf(signupChannel, notifications.signupRequestResponse),
        ])
      })

      it('forwards request to channel admins and appends phone number', () => {
        adminPhoneNumbers.forEach((adminPhoneNumber, idx) => {
          expect(sendMessageStub.getCall(idx + 1).args).to.eql([
            sock,
            adminPhoneNumber,
            sdMessageOf(
              signupChannel,
              notifications.signupRequestReceived(randomSender.phoneNumber, 'gimme a channel'),
            ),
          ])
        })
      })
    })

    describe('when message is a command response', () => {
      // TODO(aguestuser|mari): loop over all commands here
      beforeEach(async () => {
        await messenger.dispatch({
          dispatchable: { db, sock, channel, sender: adminSender, sdMessage: commands.JOIN },
          commandResult: {
            command: commands.JOIN,
            status: statuses.SUCCESS,
            message: 'yay!',
            notifications: [],
          },
        })
      })

      it('does not broadcast a message', () => {
        expect(broadcastSpy.callCount).to.eql(0)
      })

      it('does not increment the broadcast count', () => {
        expect(countBroadcastStub.callCount).to.eql(0)
      })

      it('sends a command result to the message sender', () => {
        expect(sendMessageStub.getCall(0).args).to.eql([
          sock,
          adminSender.phoneNumber,
          sdMessageOf(channel, 'yay!'),
        ])
      })

      it('increments the command count for the channel', () => {
        expect(countCommandStub.getCall(0).args).to.eql([db, channel])
      })
    })

    describe('when command result includes notification(s)', () => {
      beforeEach(async () => {
        await messenger.dispatch({
          dispatchable: { db, sock, channel, sender: adminSender, sdMessage },
          commandResult: {
            command: commands.ADD,
            status: statuses.SUCCESS,
            message: 'boofar',
            notifications: [
              ...adminPhoneNumbers.map(phoneNumber => ({
                recipient: phoneNumber,
                message: 'foobar',
              })),
            ],
          },
        })
      })

      // the first call to signal.sendMessage is to send the commandResponse, so start after that
      it('sends out each notification', () => {
        adminPhoneNumbers.forEach((phoneNumber, index) => {
          expect(sendMessageStub.getCall(index + 1).args).to.eql([
            sock,
            phoneNumber,
            sdMessageOf(channel, 'foobar'),
          ])
        })
      })
    })

    describe('modifying expiry times', () => {
      describe('for successful commands originating from a new user', () => {
        ;[commands.JOIN, commands.ACCEPT].forEach(command => {
          it(`updates the expiry time between the channel and the sender of a ${command} command`, async () => {
            await messenger.dispatch({
              dispatchable: {
                db,
                sock,
                channel,
                sender: randomSender,
                sdMessage: sdMessageOf(channel, command),
              },
              commandResult: {
                command,
                status: statuses.SUCCESS,
                message: 'fake welcome!',
                notifications: [],
              },
            })
            expect(setExpirationStub.getCall(0).args).to.eql([
              sock,
              channel.phoneNumber,
              randomSender.phoneNumber,
              channel.messageExpiryTime,
            ])
          })
        })
      })

      describe('for successful commands that add a new user', () => {
        const rawNewMemberPhoneNumber = '+1 (222) 333-4444'
        const parsedNewMemberPhoneNumber = '+12223334444'
        ;[commands.ADD, commands.INVITE].forEach(command => {
          it(`updates the expiry time between the channel and the sender of a ${command} command`, async () => {
            await messenger.dispatch({
              dispatchable: {
                db,
                sock,
                channel,
                sender: randomSender,
                sdMessage: sdMessageOf(channel, `${command} ${rawNewMemberPhoneNumber}`),
              },
              commandResult: {
                command,
                status: statuses.SUCCESS,
                message: 'fake welcome!',
                notifications: [],
              },
            })
            expect(setExpirationStub.getCall(0).args).to.eql([
              sock,
              channel.phoneNumber,
              parsedNewMemberPhoneNumber,
              channel.messageExpiryTime,
            ])
          })
        })
      })

      describe('for all other successful commands', () => {
        const cs = values(commands).filter(
          command =>
            ![commands.JOIN, commands.ACCEPT, commands.ADD, commands.INVITE].includes(command),
        )

        cs.forEach(command => {
          it(`does not update expiry times in response to a ${command} command`, async () => {
            await messenger.dispatch({
              dispatchable: {
                db,
                sock,
                channel,
                sender: randomSender,
                sdMessage: sdMessageOf(channel, command),
              },
              commandResult: {
                command,
                status: statuses.SUCCESS,
                message: 'fake command response message!',
                notifications: [],
              },
            })
            expect(setExpirationStub.callCount).to.eql(0)
          })
        })
      })

      describe('for an unsuccessful command', () => {
        it('does not modify any expiry times', async () => {
          await messenger.dispatch({
            dispatchable: {
              db,
              sock,
              channel,
              sender: randomSender,
              sdMessage: sdMessageOf(channel, commands.JOIN),
            },
            commandResult: {
              command: commands.JOIN,
              status: statuses.ERROR,
              message: 'fake command response error message!',
            },
          })
          expect(setExpirationStub.callCount).to.eql(0)
        })
      })
    })
  })

  describe('message headers', () => {
    describe('broadcast messages', () => {
      it('adds a channel name header', () => {
        const msg = { channel, sdMessage: sdMessageOf(channel, 'blah') }
        expect(messenger.addHeader(msg)).to.eql(sdMessageOf(channel, '[foobar]\nblah'))
      })
    })

    describe('hotline message', () => {
      it('adds an HOTLINE MESSAGE header', () => {
        const msg = {
          channel,
          sdMessage: sdMessageOf(channel, 'blah'),
          messageType: messageTypes.HOTLINE_MESSAGE,
          language: languages.EN,
        }
        expect(messenger.addHeader(msg)).to.eql(
          sdMessageOf(channel, `[${messages.prefixes.hotlineMessage}]\nblah`),
        )
      })
    })
  })
})
