import { expect } from 'chai'
import { describe, it, beforeEach, afterEach, before, after } from 'mocha'
import sinon from 'sinon'
import { times, merge } from 'lodash'
import { languages } from '../../../app/language'
import { memberTypes } from '../../../app/db/repositories/membership'
import { dispatch } from '../../../app/dispatcher'
import channelRepository, { getAllAdminsExcept } from '../../../app/db/repositories/channel'
import membershipRepository from '../../../app/db/repositories/membership'
import signal, { messageTypes, sdMessageOf } from '../../../app/signal/signal'
import executor from '../../../app/dispatcher/commands'
import messenger from '../../../app/dispatcher/messenger'
import resend from '../../../app/dispatcher/resend'
import safetyNumberService from '../../../app/registrar/safetyNumbers'
import logger from '../../../app/dispatcher/logger'
import { deepChannelFactory } from '../../support/factories/channel'
import { genPhoneNumber } from '../../support/factories/phoneNumber'
import { wait } from '../../../app/util'
import { messagesIn } from '../../../app/dispatcher/strings/messages'
import { adminMembershipFactory } from '../../support/factories/membership'
import { inboundAttachmentFactory } from '../../support/factories/sdMessage'
import app from '../../../app/index'
import testApp from '../../support/testApp'

const {
  signal: { defaultMessageExpiryTime, supportPhoneNumber, minResendInterval },
} = require('../../../app/config')

describe('dispatcher module', () => {
  const channels = times(2, deepChannelFactory)
  const channel = channels[0]
  const adminPhoneNumber = channels[0].memberships[0].memberPhoneNumber
  const subscriberPhoneNumber = channels[0].memberships[2].memberPhoneNumber
  const randoPhoneNumber = genPhoneNumber()
  const sender = {
    phoneNumber: adminPhoneNumber,
    language: languages.EN,
    type: memberTypes.ADMIN,
  }
  const sdInMessage = {
    type: messageTypes.MESSAGE,
    data: {
      username: channel.phoneNumber,
      source: adminPhoneNumber,
      dataMessage: {
        timestamp: new Date().getTime(),
        message: 'foo',
        expiresInSeconds: defaultMessageExpiryTime,
        attachments: [],
      },
    },
  }
  const sdOutMessage = signal.parseOutboundSdMessage(sdInMessage)
  const socketDelay = 5

  let findDeepStub,
    resolveMemberTypeStub,
    trustAndResendStub,
    deauthorizeStub,
    processCommandStub,
    dispatchStub,
    logAndReturnSpy,
    logErrorSpy,
    sendMessageStub,
    enqueueResendStub

  before(async () => await app.run(testApp))

  beforeEach(async () => {
    sinon.stub(channelRepository, 'findAllDeep').returns(Promise.resolve(channels))
    sinon.stub(signal, 'subscribe').returns(Promise.resolve())

    findDeepStub = sinon.stub(channelRepository, 'findDeep').returns(Promise.resolve(channels[0]))

    resolveMemberTypeStub = sinon
      .stub(membershipRepository, 'resolveMemberType')
      .returns(Promise.resolve(memberTypes.ADMIN))

    sinon.stub(membershipRepository, 'resolveSenderLanguage').returns(languages.EN)

    trustAndResendStub = sinon
      .stub(safetyNumberService, 'trustAndResend')
      .returns(Promise.resolve({ status: 'SUCCESS', message: 'fake trust success' }))

    deauthorizeStub = sinon
      .stub(safetyNumberService, 'deauthorize')
      .returns(Promise.resolve({ status: 'SUCCESS', message: 'fake deauthorize success' }))

    processCommandStub = sinon
      .stub(executor, 'processCommand')
      .returns(Promise.resolve({ command: 'NOOP', status: 'SUCCESS', message: 'foo' }))

    dispatchStub = sinon.stub(messenger, 'dispatch').returns(Promise.resolve())

    sendMessageStub = sinon.stub(signal, 'sendMessage').returns(Promise.resolve())

    enqueueResendStub = sinon.stub(resend, 'enqueueResend')

    logAndReturnSpy = sinon.spy(logger, 'logAndReturn')
    logErrorSpy = sinon.spy(logger, 'error')
  })

  afterEach(() => sinon.restore())

  after(() => app.stop())

  describe('handling an incoming message', () => {
    describe('deciding whether to dispatch a message', () => {
      describe('when message is not of type "message"', () => {
        it('ignores the message', async () => {
          await dispatch(
            JSON.stringify({
              type: 'list_groups',
              data: { username: '+12223334444' },
            }),
          )
          expect(processCommandStub.callCount).to.eql(0)
          expect(dispatchStub.callCount).to.eql(0)
        })
      })

      describe('when message is of type "message"', () => {
        describe('when message has a body', () => {
          it('dispatches the message', async () => {
            await dispatch(
              JSON.stringify({
                type: 'message',
                data: {
                  username: channel.phoneNumber,
                  source: genPhoneNumber(),
                  dataMessage: {
                    timestamp: new Date().toISOString(),
                    message: 'foobar',
                    expiresInSeconds: channel.messageExpiryTime,
                    attachments: [],
                  },
                },
              }),
            )
            expect(processCommandStub.callCount).to.be.above(0)
            expect(dispatchStub.callCount).to.be.above(0)
          })
        })

        describe('when message lacks a body but contains an attachment', () => {
          it('dispatches the message', async () => {
            await dispatch(
              JSON.stringify({
                type: 'message',
                data: {
                  dataMessage: {
                    message: '',
                    attachments: ['cool pix!'],
                  },
                },
              }),
            )
            expect(processCommandStub.callCount).to.be.above(0)
            expect(dispatchStub.callCount).to.be.above(0)
          })
        })
      })
    })

    describe('when message lacks a body AND an attachment', () => {
      it('ignores the message', async () => {
        await dispatch(JSON.stringify({ type: 'message', data: { receipt: { type: 'READ' } } }))
        expect(processCommandStub.callCount).to.eql(0)
        expect(dispatchStub.callCount).to.eql(0)
      })
    })

    describe('dispatching a message', () => {
      beforeEach(async () => await dispatch(JSON.stringify(sdInMessage)))

      it('retrieves a channel record', () => {
        expect(findDeepStub.getCall(0).args).to.eql([channel.phoneNumber])
      })

      it('retrieves permissions for the message sender', () => {
        expect(resolveMemberTypeStub.getCall(0).args).to.eql([
          channel.phoneNumber,
          adminPhoneNumber,
        ])
      })

      it('processes any commands in the message', () => {
        expect(processCommandStub.getCall(0).args[0]).to.eql({
          channel,
          sender,
          sdMessage: sdOutMessage,
        })
      })

      it('passes the command result and original message to messenger for dispatch', () => {
        expect(dispatchStub.getCall(0).args[0]).to.eql({
          commandResult: { command: 'NOOP', status: 'SUCCESS', message: 'foo' },
          dispatchable: {
            channel,
            sender,
            sdMessage: sdOutMessage,
          },
        })
      })
    })

    describe('and the recipient is a random person (why would this ever happen?)', () => {
      beforeEach(async () => resolveMemberTypeStub.returns(memberTypes.NONE))

      it('drops the message', async () => {
        await dispatch(JSON.stringify(sdInMessage))
        expect(trustAndResendStub.callCount).to.eql(0) // does not attempt to resend
        expect(deauthorizeStub.callCount).to.eql(0) // does not attempt to deauth
      })
    })

    describe('when message is a rate limit error notification', () => {
      const supportChannel = deepChannelFactory({
        phoneNumber: supportPhoneNumber,
        memberships: ['EN', 'ES', 'FR'].map(language =>
          adminMembershipFactory({ channelPhoneNumber: supportPhoneNumber, language }),
        ),
      })
      const recipientNumber = genPhoneNumber()
      const messageBody = '[foo]\nbar'
      const originalSdMessage = {
        type: 'send',
        username: channel.phoneNumber,
        messageBody,
        recipientNumber,
        attachments: [],
        expiresInSeconds: 0,
      }
      const sdErrorMessage = {
        type: signal.messageTypes.ERROR,
        data: {
          msg_number: 0,
          error: true,
          message: 'Rate limit exceeded: 413',
          username: channel.phoneNumber,
          request: originalSdMessage,
        },
      }

      beforeEach(() => enqueueResendStub.returns(minResendInterval))

      describe('and there is a support channel', () => {
        beforeEach(async () => {
          findDeepStub.returns(Promise.resolve(supportChannel))
          await dispatch(JSON.stringify(sdErrorMessage), {})
        })

        it('enqueues the message for resending', () => {
          expect(enqueueResendStub.getCall(0).args).to.eql([originalSdMessage])
        })

        it('notifies admins of the support channel', () => {
          supportChannel.memberships.forEach(({ memberPhoneNumber, language }, idx) =>
            expect(sendMessageStub.getCall(idx).args).to.eql([
              memberPhoneNumber,
              sdMessageOf(
                { phoneNumber: supportPhoneNumber },
                messagesIn(language).notifications.rateLimitOccurred(
                  channel.phoneNumber,
                  minResendInterval,
                ),
              ),
            ]),
          )
        })
      })

      describe('and there is not a support channel', () => {
        beforeEach(async () => {
          findDeepStub.returns(Promise.resolve(null))
          await dispatch(JSON.stringify(sdErrorMessage), {})
          await wait(2 * socketDelay)
        })

      it('enqueues the message for resending', () => {
        expect(enqueueResendStub.getCall(0).args).to.eql([originalSdMessage])
      })
    })

    describe('when message is an untrusted identity error notification', () => {
      const recipientNumber = genPhoneNumber()
      const messageBody = '[foo]\nbar'
      const inboundAttachment = inboundAttachmentFactory()
      const originalSdMessage = {
        type: 'send',
        username: channel.phoneNumber,
        messageBody,
        recipientNumber,
        attachments: [inboundAttachment],
        expiresInSeconds: 0,
      }
      const fingerprint =
        '05 45 8d 63 1c c4 14 55 bf 6d 24 9f ec cb af f5 8d e4 c8 d2 78 43 3c 74 8d 52 61 c4 4a e7 2c 3d 53 '
      const sdErrorMessage = {
        type: signal.messageTypes.UNTRUSTED_IDENTITY,
        data: {
          username: channel.phoneNumber,
          number: recipientNumber,
          fingerprint,
          safety_number: '074940190139780110760016007890517723684588610476310913703803',
          request: originalSdMessage,
        },
      }

      describe('when intended recipient is a subscriber', () => {
        beforeEach(async () => resolveMemberTypeStub.returns(memberTypes.SUBSCRIBER))

        it("attempts to trust the recipient's safety number and re-send the message", async () => {
          await dispatch(JSON.stringify(sdErrorMessage), {})

          expect(deauthorizeStub.callCount).to.eql(0) // does not attempt to deauthorize user
          expect(trustAndResendStub.getCall(0).args).to.eql([
            {
              channelPhoneNumber: channel.phoneNumber,
              memberPhoneNumber: recipientNumber,
              fingerprint,
              sdMessage: signal.parseOutboundSdMessage(originalSdMessage),
            },
          ])
        })

        describe('when trusting succeeds', () => {
          // this is the default stub
          it('logs the success', async () => {
            await dispatch(JSON.stringify(sdErrorMessage), {})
            expect(logAndReturnSpy.getCall(0).args).to.eql([
              {
                status: 'SUCCESS',
                message: 'fake trust success',
              },
            ])
          })
        })

        describe('when trusting fails', () => {
          const errorStatus = { status: 'ERROR', message: 'fake trust error' }
          beforeEach(() => trustAndResendStub.callsFake(() => Promise.reject(errorStatus)))

          it('logs the failure', async () => {
            await dispatch(JSON.stringify(sdErrorMessage))
            expect(logErrorSpy.getCall(0).args).to.eql([errorStatus])
          })
        })
      })

      describe('when intended recipient is an admin', () => {
        beforeEach(async () => resolveMemberTypeStub.returns(memberTypes.ADMIN))

        it('attempts to deauthorize the admin', async () => {
          await dispatch(JSON.stringify(sdErrorMessage))

          expect(trustAndResendStub.callCount).to.eql(0) // does not attempt to resend
          expect(deauthorizeStub.getCall(0).args[0]).to.eql({
            channelPhoneNumber: channel.phoneNumber,
            memberPhoneNumber: recipientNumber,
            fingerprint,
            sdMessage: signal.parseOutboundSdMessage(originalSdMessage),
          })
        })

        describe('when deauth succeeds', () => {
          // this is the default stub
          it('logs the success', async () => {
            await dispatch(JSON.stringify(sdErrorMessage))
            expect(logAndReturnSpy.getCall(0).args).to.eql([
              {
                status: 'SUCCESS',
                message: 'fake deauthorize success',
              },
            ])
          })
        })

        describe('when deauth fails', () => {
          const errorStatus = { status: 'ERROR', message: 'fake deauthorize error' }
          beforeEach(() => deauthorizeStub.callsFake(() => Promise.reject(errorStatus)))

          it('logs the failure', async () => {
            await dispatch(JSON.stringify(sdErrorMessage))
            expect(logErrorSpy.getCall(0).args).to.eql([errorStatus])
          })
        })
      })
    })

    describe('expiry time updates', () => {
      const expiryUpdate = merge({}, sdInMessage, {
        data: {
          dataMessage: {
            expiresInSeconds: 60,
            messageBody: '',
          },
        },
      })

      let updateStub, setExpirationStub
      beforeEach(() => {
        updateStub = sinon.stub(channelRepository, 'update')
        setExpirationStub = sinon.stub(signal, 'setExpiration')
      })
      afterEach(() => {
        updateStub.restore()
        setExpirationStub.restore()
      })

      describe('from an admin', () => {
        beforeEach(async () => await dispatch(JSON.stringify(expiryUpdate)))

        it('stores the new expiry time', () => {
          expect(updateStub.getCall(0).args).to.eql([
            channel.phoneNumber,
            { messageExpiryTime: 60 },
          ])
        })

        it('updates the expiry time between the channel and every other channel member', () => {
          getAllAdminsExcept(channel, [adminPhoneNumber]).forEach((membership, i) =>
            expect(setExpirationStub.getCall(i).args).to.eql([
              channel.phoneNumber,
              membership.memberPhoneNumber,
              60,
            ]),
          )
        })
      })

      describe('from a subscriber', () => {
        const subscriberExpiryUpdate = merge({}, expiryUpdate, {
          data: { source: subscriberPhoneNumber },
        })
        beforeEach(async () => {
          resolveMemberTypeStub.returns(Promise.resolve(memberTypes.SUBSCRIBER))
          await dispatch(JSON.stringify(subscriberExpiryUpdate))
        })

        it('sets the expiry time btw/ channel and sender back to original expiry time', () => {
          expect(setExpirationStub.getCall(0).args).to.eql([
            channel.phoneNumber,
            subscriberPhoneNumber,
            defaultMessageExpiryTime,
          ])
        })
      })

      describe('from a rando', () => {
        const randoExpiryUpdate = merge({}, expiryUpdate, {
          data: { source: randoPhoneNumber },
        })
        beforeEach(async () => {
          resolveMemberTypeStub.returns(Promise.resolve(memberTypes.NONE))
          await dispatch(JSON.stringify(randoExpiryUpdate))
        })

        it('is ignored', () => {
          expect(setExpirationStub.callCount).to.eql(0)
        })
      })

      describe('with a message body', () => {
        const expiryUpdateWithBody = merge({}, expiryUpdate, {
          data: {
            source: randoPhoneNumber,
            dataMessage: {
              message: 'HELLO',
            },
          },
        })

        beforeEach(async () => {
          resolveMemberTypeStub.returns(Promise.resolve(memberTypes.NONE))
          await dispatch(JSON.stringify(expiryUpdateWithBody))
        })

        it('still relays message', async () => {
          expect(processCommandStub.getCall(0).args[0].sdMessage.messageBody).to.eql('HELLO')
        })
      })
    })
  })
})
