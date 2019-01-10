import { expect } from 'chai'
import { describe, it, beforeEach, afterEach } from 'mocha'
import sinon from 'sinon'
import util from '../../../../app/service/util'
import { EventEmitter } from 'events'
import { times } from 'lodash'
import {
  registerAll,
  register,
  verify,
  parseVerificationCode,
} from '../../../../app/service/phoneNumber/register'
import { statuses, errors } from '../../../../app/service/phoneNumber/index'
import { genPhoneNumber } from '../../../support/factories/phoneNumber'

describe('phone number service -- registration module', () => {
  const phoneNumber = genPhoneNumber()
  const purchasedNumbers = times(3, () => ({
    phoneNumber: genPhoneNumber(),
    status: statuses.PURCHASED,
  }))
  const emitter = new EventEmitter()
  const registeredStatus = { status: statuses.REGISTERED, phoneNumber }
  const verifiedStatus = { status: statuses.VERIFIED, phoneNumber }
  const errorStatus = { status: statuses.ERROR, phoneNumber, error: 'oh noes!' }
  const timeoutStatus = { status: statuses.ERROR, phoneNumber, error: errors.verificationTimeout }
  const verificationMessage = 'Your Signal verification code: 809-842 for +14322239406'
  const emitOffset = 10
  const db = { phoneNumber: { update: () => {}, find: () => {} } }

  let execStub, updateStub, findStub

  beforeEach(() => {
    execStub = sinon.stub(util, 'exec')
    updateStub = sinon.stub(db.phoneNumber, 'update')
    findStub = sinon.stub(db.phoneNumber, 'find')
  })

  afterEach(() => {
    execStub.restore()
    updateStub.restore()
    findStub.restore()
  })

  describe('registering all purchased numbers with signal', () => {
    // NOTE(aguestuser): we focus on happy path in this bracket b/c
    // sad paths are tested exhaustively in `registering a number with signal ` bracket (below)

    describe('when all registrations succeed', () => {
      beforeEach(() => {
        findStub.returns(Promise.resolve(purchasedNumbers))
        execStub.returns(Promise.resolve())
        updateStub.callsFake(({ status }, { where: { phoneNumber } }) =>
          Promise.resolve([1, [{ status, phoneNumber }]]),
        )
        purchasedNumbers.forEach(({ phoneNumber }) => {
          setTimeout(() => emitter.emit('verified', { ...verifiedStatus, phoneNumber }), emitOffset)
        })
      })

      it('returns an array of success statuses', async () => {
        expect(await registerAll({ db, emitter })).to.eql([
          {
            status: statuses.VERIFIED,
            phoneNumber: purchasedNumbers[0].phoneNumber,
          },
          {
            status: statuses.VERIFIED,
            phoneNumber: purchasedNumbers[1].phoneNumber,
          },
          {
            status: statuses.VERIFIED,
            phoneNumber: purchasedNumbers[2].phoneNumber,
          },
        ])
      })
    })

    describe('when one registration fails', () => {
      beforeEach(() => {
        findStub.returns(Promise.resolve(purchasedNumbers))
        execStub.onCall(0).returns(Promise.reject('boom!'))
        execStub.onCall(1).returns(Promise.resolve())
        execStub.onCall(2).returns(Promise.resolve())
        updateStub.callsFake(({ status }, { where: { phoneNumber } }) =>
          Promise.resolve([1, [{ status, phoneNumber }]]),
        )
        purchasedNumbers.forEach(({ phoneNumber }) => {
          setTimeout(() => emitter.emit('verified', { ...verifiedStatus, phoneNumber }), emitOffset)
        })
      })

      it('returns an array of success AND error statuses', async () => {
        expect(await registerAll({ db, emitter })).to.eql([
          {
            status: statuses.ERROR,
            phoneNumber: purchasedNumbers[0].phoneNumber,
            error: errors.registrationFailed('boom!'),
          },
          {
            status: statuses.VERIFIED,
            phoneNumber: purchasedNumbers[1].phoneNumber,
          },
          {
            status: statuses.VERIFIED,
            phoneNumber: purchasedNumbers[2].phoneNumber,
          },
        ])
      })
    })
  })

  describe('registering a number with signal', () => {
    describe('when registration succeeds', () => {
      beforeEach(() => execStub.returns(Promise.resolve()))

      describe('when saving registration status succeeds', () => {
        beforeEach(() => {
          updateStub.returns(Promise.resolve([1, [registeredStatus]]))
        })

        describe('in all cases', () => {
          beforeEach(async () => await register({ db, emitter, phoneNumber }))

          it('listens for successful verification', () => {
            expect(emitter.emit('verified')).to.eql(true)
          })

          it('listens for failed verification', () => {
            expect(emitter.emit('verificationFailed')).to.eql(true)
          })
        })

        describe('when verification success event is fired', () => {
          beforeEach(() => setTimeout(() => emitter.emit('verified', verifiedStatus), emitOffset))

          it('returns a success status', async () => {
            expect(await register({ db, emitter, phoneNumber })).to.eql(verifiedStatus)
          })
        })

        describe('when verification failure event is fired', () => {
          beforeEach(() =>
            setTimeout(() => emitter.emit('verificationFailed', errorStatus), emitOffset),
          )

          it('returns an error status', async () => {
            expect(await register({ db, emitter, phoneNumber })).to.eql(errorStatus)
          })
        })

        describe('when no verification event fires', () => {
          it('returns an error status after a timeout interval', async () => {
            expect(await register({ db, emitter, phoneNumber })).to.eql(timeoutStatus)
          })
        })

        describe('when a verification event for a different phone number is fired', () => {
          const otherNumberSuccessStatus = { ...verifiedStatus, phoneNumber: genPhoneNumber() }
          beforeEach(() =>
            setTimeout(() => emitter.emit('verified', otherNumberSuccessStatus), emitOffset),
          )

          it('returns an error status after a timeout interval', async () => {
            expect(await register({ db, emitter, phoneNumber })).to.eql(timeoutStatus)
          })
        })
      })

      describe('when recording registration fails', () => {
        beforeEach(() => updateStub.callsFake(() => Promise.reject('wild database error!')))

        it('returns an error status', async () => {
          expect(await register({ db, emitter, phoneNumber })).to.eql({
            status: statuses.ERROR,
            phoneNumber,
            error: errors.registrationFailed('wild database error!'),
          })
        })
      })
    })
    describe('when registration fails', () => {
      beforeEach(() => execStub.callsFake(() => Promise.reject('foo')))

      it('returns an error status', async () => {
        expect(await register({ db, emitter, phoneNumber })).to.eql({
          status: statuses.ERROR,
          phoneNumber,
          error: errors.registrationFailed('foo'),
        })
      })
    })
  })

  describe('verifying a number with signal', () => {
    const verifiedEventSpy = sinon.spy()
    const verificationFailedEventSpy = sinon.spy()

    beforeEach(() => {
      emitter.on('verified', verifiedEventSpy)
      emitter.on('verificationFailed', verificationFailedEventSpy)
    })

    afterEach(() => {
      emitter.removeAllListeners()
    })

    describe('when verification succeeds', () => {
      beforeEach(() => execStub.returns(Promise.resolve()))

      // it('attempts to record the success')

      describe('when recording verification succeeds', () => {
        beforeEach(() => updateStub.returns(Promise.resolve([1, [verifiedStatus]])))

        it('emits a success event', async () => {
          await verify({ db, emitter, phoneNumber, verificationMessage })
          expect(verifiedEventSpy.getCall(0).args).to.eql([verifiedStatus])
        })
      })

      describe('when recording verification fails', () => {
        beforeEach(() => updateStub.callsFake(() => Promise.reject('boom!')))

        it('emits an error event', async () => {
          await verify({ db, emitter, phoneNumber, verificationMessage }).catch(x => x)
          expect(verificationFailedEventSpy.getCall(0).args).to.eql([
            {
              status: statuses.ERROR,
              phoneNumber,
              error: errors.verificationFailed('boom!'),
            },
          ])
        })
      })
    })
    describe('when verification fails', () => {
      beforeEach(() => execStub.callsFake(() => Promise.reject('boom!')))

      it('emits an error event', async () => {
        await verify({ db, emitter, phoneNumber, verificationMessage }).catch(x => x)
        expect(verificationFailedEventSpy.getCall(0).args).to.eql([
          {
            status: statuses.ERROR,
            phoneNumber,
            error: errors.verificationFailed('boom!'),
          },
        ])
      })
    })
  })

  describe('helpers', () => {
    describe('#parseVerificationCode', () => {
      it('extracts a verification code from a verification message', () => {
        expect(
          parseVerificationCode('Your Signal verification code: 809-842 for +14322239406'),
        ).to.eql('809-842')
      })
    })
  })
})
