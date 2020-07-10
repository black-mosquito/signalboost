import { expect } from 'chai'
import { describe, it, before, beforeEach, after, afterEach } from 'mocha'
import sinon from 'sinon'
import { keys } from 'lodash'
import { wait } from '../../../app/util'
import callbacks from '../../../app/signal/callbacks'
import signal, {
  messageTypes,
  parseOutboundAttachment,
  parseVerificationCode,
} from '../../../app/signal'
import socket from '../../../app/socket/write'
import { genPhoneNumber } from '../../support/factories/phoneNumber'
import { genFingerprint } from '../../support/factories/deauthorization'
import {
  inboundAttachmentFactory,
  outboundAttachmentFactory,
} from '../../support/factories/sdMessage'
import app from '../../../app'
import testApp from '../../support/testApp'

describe('signal module', () => {
  describe('sending signald commands', () => {
    const channelPhoneNumber = genPhoneNumber()
    const subscriberNumber = genPhoneNumber()
    const fingerprint = genFingerprint()
    let writeStub

    const emit = async msg => {
      const sock = await app.socketPool.acquire()
      sock.emit('data', JSON.stringify(msg) + '\n')
      app.socketPool.release(sock)
    }
    const emitWithDelay = (delay, msg) => wait(delay).then(() => emit(msg))

    before(async () => await app.run({ ...testApp, signal }))
    beforeEach(async () => (writeStub = sinon.stub(socket, 'write').returns(Promise.resolve())))
    afterEach(async () => sinon.restore())
    after(async () => {
      await wait(10)
      await app.stop()
    })

    it('sends a subscribe command', () => {
      signal.subscribe(channelPhoneNumber)

      expect(writeStub.getCall(0).args[0]).to.eql({
        type: 'subscribe',
        username: channelPhoneNumber,
      })
    })

    it('sends an unsubscribe command', () => {
      signal.unsubscribe(channelPhoneNumber)

      expect(writeStub.getCall(0).args[0]).to.eql({
        type: 'unsubscribe',
        username: channelPhoneNumber,
      })
    })

    it('sends a signal message', async () => {
      const sdMessage = {
        type: 'send',
        username: channelPhoneNumber,
        recipientAddress: null,
        messageBody: 'hello world!',
        attachments: [],
      }
      await signal.sendMessage('+12223334444', sdMessage)

      expect(writeStub.getCall(0).args[0]).to.eql({
        type: 'send',
        username: channelPhoneNumber,
        recipientAddress: {
          number: '+12223334444',
        },
        messageBody: 'hello world!',
        attachments: [],
      })
    })

    it('broadcasts a signal message', async () => {
      const sdMessage = {
        type: 'send',
        username: channelPhoneNumber,
        recipientAddress: null,
        messageBody: 'hello world!',
        attachments: [],
      }
      const recipients = ['+11111111111', '+12222222222']
      await signal.broadcastMessage(recipients, sdMessage)

      expect(writeStub.getCall(0).args[0]).to.eql({
        type: 'send',
        username: channelPhoneNumber,
        recipientAddress: { number: '+11111111111' },
        messageBody: 'hello world!',
        attachments: [],
      })

      expect(writeStub.getCall(1).args[0]).to.eql({
        type: 'send',
        username: channelPhoneNumber,
        recipientAddress: { number: '+12222222222' },
        messageBody: 'hello world!',
        attachments: [],
      })
    })

    describe('trusting an expired fingerprint', () => {
      const trustRequest = {
        type: messageTypes.TRUST,
        username: channelPhoneNumber,
        recipientAddress: { number: subscriberNumber },
        fingerprint,
      }
      const trustResponse = {
        type: messageTypes.TRUSTED_FINGERPRINT,
        data: {
          msg_number: 0,
          message: 'Successfully trusted fingerprint',
          error: true,
          request: trustRequest,
        },
      }

      describe('when trust request succeeds', () => {
        it('returns a success object', async () => {
          const promises = await Promise.all([
            signal.trust(channelPhoneNumber, subscriberNumber, fingerprint),
            emitWithDelay(10, trustResponse),
          ])
          const result = promises[0]

          expect(result).to.eql({
            status: 'SUCCESS',
            message: callbacks.messages.trust.success(channelPhoneNumber, subscriberNumber),
          })
        })
      })

      describe('when trust request times out', () => {
        it('rejects with an error object', async () => {
          const result = await signal
            .trust(channelPhoneNumber, subscriberNumber, fingerprint)
            .catch(a => a)
          expect(result).to.eql({
            status: 'ERROR',
            message: callbacks.messages.timeout(messageTypes.TRUST),
          })
        })
      })
    })

    describe('registering a phone number', () => {
      const verifySuccessResponse = {
        type: messageTypes.VERIFICATION_SUCCESS,
        data: { username: channelPhoneNumber },
      }
      const verifyErrorResponse = {
        type: messageTypes.VERIFICATION_ERROR,
        data: { username: channelPhoneNumber },
      }

      let result

      describe('in all cases', () => {
        it('sends a verify command', async () => {
          await signal.verify(channelPhoneNumber, '111-222').catch(e => e)

          expect(writeStub.getCall(0).args[0]).to.eql({
            type: 'verify',
            username: channelPhoneNumber,
            code: '111-222',
          })
        })
      })

      describe('when a verification success message for the listening channel is emitted', () => {
        beforeEach(async () => {
          wait(5).then(() => emit(verifySuccessResponse))
          result = await signal.register(channelPhoneNumber)
        })

        it('sends a register command', () => {
          expect(writeStub.getCall(0).args[0]).to.eql({
            type: 'register',
            username: channelPhoneNumber,
          })
        })

        it('resolves with a success message', async () => {
          expect(result).to.eql({ status: 'SUCCESS', message: channelPhoneNumber.toString() })
        })
      })

      describe('when a verification failure message for the listening channel is emitted', () => {
        beforeEach(async () => {
          wait(5).then(() => emit(verifyErrorResponse))
          result = await signal.register(channelPhoneNumber).catch(a => a)
        })

        it('rejects with a failure error message', async () => {
          expect(result).to.be.an('Error')
          expect(result.message).to.eql(
            callbacks.messages.verification.error(channelPhoneNumber, 'Captcha required: 402'),
          )
        })
      })

      describe('when no verification message is emitted before the timeout threshold', () => {
        beforeEach(async () => {
          result = await signal.register(channelPhoneNumber).catch(a => a)
        })

        it('rejects with a timeout error', async () => {
          expect(result.message).to.eql(callbacks.messages.timeout(messageTypes.VERIFY))
        })
      })

      describe('when a verification success message for another channel is emitted', () => {
        beforeEach(async () => {
          wait(5).then(() =>
            emit({
              type: messageTypes.VERIFICATION_SUCCESS,
              data: { username: genPhoneNumber() },
            }),
          )
          result = await signal.register(channelPhoneNumber).catch(e => e)
        })

        it('rejects with timeout error', () => {
          expect(result.message).to.eql(callbacks.messages.timeout(messageTypes.VERIFY))
        })
      })
    })

    describe('verifying a signal auth code', () => {
      describe('in all cases', () => {
        it('sends a verify command', async () => {
          await signal.verify(channelPhoneNumber, '111-222').catch(e => e)
          expect(writeStub.getCall(0).args[0]).to.eql({
            type: 'verify',
            username: channelPhoneNumber,
            code: '111-222',
          })
        })
      })

      describe('when socket write succeeds', () => {
        // TODO: add a sad path test here (not very valuable but nice for coverage)
        //  (will require overwriting the `sock.write` impl in testApp to invoke cb(true, undefined))
        it('returns an OK status', async () => {
          expect(await signal.verify(channelPhoneNumber, '123-456')).to.eql({
            status: 'SUCCESS',
            message: 'OK',
          })
        })
      })
    })
  })

  describe('message parsing', () => {
    const channelPhoneNumber = genPhoneNumber()
    const adminPhoneNumber = genPhoneNumber()
    const subscriberPhoneNumber = genPhoneNumber()

    it('parses an output signald message from an inbound signald message', () => {
      const inMessage = {
        type: messageTypes.MESSAGE,
        data: {
          username: channelPhoneNumber,
          source: { number: adminPhoneNumber },
          sourceDevice: 2,
          type: 'CIPHERTEXT',
          timestamp: 1593049240228,
          timestampISO: '2020-06-25T01:40:40.228Z',
          serverTimestamp: 1593049240375,
          hasLegacyMessage: false,
          hasContent: true,
          isUnidentifiedSender: false,
          dataMessage: {
            timestamp: 1593049240228,
            body: 'hello world!',
            endSession: false,
            expiresInSeconds: 0,
            profileKeyUpdate: false,
            viewOnce: false,
          },
        },
      }

      expect(signal.parseOutboundSdMessage(inMessage)).to.eql({
        type: messageTypes.SEND,
        username: channelPhoneNumber,
        recipientAddress: undefined,
        messageBody: 'hello world!',
        attachments: [],
      })
    })

    it('parses a message with attachments successfully', () => {
      const inMessage = {
        type: 'message',
        data: {
          username: channelPhoneNumber,
          source: { number: adminPhoneNumber },
          sourceDevice: 2,
          type: 'CIPHERTEXT',
          timestamp: 1593049458531,
          timestampISO: '2020-06-25T01:44:18.531Z',
          serverTimestamp: 1593049459321,
          hasLegacyMessage: false,
          hasContent: true,
          isUnidentifiedSender: false,
          endSession: false,
          expiresInSeconds: 0,
          profileKeyUpdate: false,
          viewOnce: false,
          dataMessage: {
            timestamp: 1593049458531,
            attachments: [
              {
                contentType: 'image/svg+xml',
                id: 843096872067478927,
                size: 1714,
                storedFilename: '/var/lib/signald/attachments/843096872067478927',
                caption: 'foobar',
                width: 0,
                height: 0,
                voiceNote: false,
                key:
                  'nPa/YAJ2diyCpUYlAkUL/G5ORfzDSpP0GQCDBquy0e57vJ+/CKMlL1Uo53546IZblnXJYzKpz+7gbCeryo+wMA==',
                digest: '1/Hn4gpQIVGthpq9Q+IsEs9GuKr+KRF7YmW/4U/BGkw=',
              },
            ],
          },
        },
      }

      expect(signal.parseOutboundSdMessage(inMessage)).to.eql({
        type: messageTypes.SEND,
        username: channelPhoneNumber,
        recipientAddress: undefined,
        messageBody: '',
        attachments: [
          {
            filename: '/var/lib/signald/attachments/843096872067478927',
            width: 0,
            height: 0,
            voiceNote: false,
            caption: 'foobar',
          },
        ],
      })
    })

    it('transforms a resend request message successfully', () => {
      const resendRequestMessage = {
        type: messageTypes.SEND,
        username: channelPhoneNumber,
        recipientAddress: { number: subscriberPhoneNumber },
        messageBody: 'hello world!',
        attachments: [inboundAttachmentFactory()],
      }

      expect(signal.parseOutboundSdMessage(resendRequestMessage)).to.eql({
        type: messageTypes.SEND,
        username: channelPhoneNumber,
        recipientAddress: { number: subscriberPhoneNumber },
        messageBody: 'hello world!',
        attachments: [outboundAttachmentFactory()],
      })
    })

    describe('parsing the filename for an outbound message attachment', () => {
      const inboundAttachment = inboundAttachmentFactory()

      it('keeps the fields in the signald spec (minus preview)', () => {
        expect(keys(parseOutboundAttachment(inboundAttachment))).to.have.members([
          'filename',
          'caption',
          'height',
          'width',
          'voiceNote',
        ])
      })

      it('discards all other fields', () => {
        const members = keys(parseOutboundAttachment(inboundAttachment))
        ;['contentType', 'id', 'size', 'preview', 'key', 'digest'].forEach(member =>
          expect(members).not.to.include(member),
        )
      })

      it('parses a filename from a storedFilename', () => {
        expect(signal.parseOutboundAttachment(inboundAttachment).filename).to.eql(
          inboundAttachment.storedFilename,
        )
      })

      it('parses a filename from a filename', () => {
        expect(
          signal.parseOutboundAttachment({
            ...inboundAttachment,
            storedFilename: undefined,
            filename: 'bar',
          }).filename,
        ).to.eql('bar')
      })

      it('parses an empty string if neither storedFilename or filename found', () => {
        expect(
          signal.parseOutboundAttachment({
            ...inboundAttachment,
            storedFilename: undefined,
          }).filename,
        ).to.eql('')
      })
    })

    describe('parsing sms messages from twilio', () => {
      it('parses a signal verification code from an sms message', () => {
        expect(parseVerificationCode('Your Signal verification code: 123-456')).to.eql([
          true,
          '123-456',
        ])
      })

      it('returns an error from an sms message that is not a verification code', () => {
        expect(parseVerificationCode('JOIN')).to.eql([false, 'JOIN'])
      })
    })
  })
})