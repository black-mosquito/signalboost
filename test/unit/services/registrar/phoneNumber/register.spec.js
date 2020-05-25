import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import sinon from 'sinon'
import fs from 'fs-extra'
import { times } from 'lodash'
import signal from '../../../../../app/services/signal'
import phoneNumberRepository from '../../../../../app/db/repositories/phoneNumber'
import {
  errors,
  statuses as pnStatuses,
} from '../../../../../app/services/registrar/phoneNumber/index'
import { statuses } from '../../../../../app/constants'
import { genPhoneNumber, phoneNumberFactory } from '../../../../support/factories/phoneNumber'
import { wait } from '../../../../../app/services/util'
import logger from '../../../../../app/services/registrar/logger'
import {
  register,
  registerAllUnregistered,
  registerMany,
  verify,
} from '../../../../../app/services/registrar/phoneNumber/register'

const {
  signal: {
    registrationBatchSize,
    intervalBetweenRegistrationBatches,
    intervalBetweenRegistrations,
  },
} = require('../../../../../app/config/index')

describe('phone number services -- registration module', () => {
  const phoneNumber = genPhoneNumber()
  const phoneNumbers = times(3, phoneNumberFactory)
  const purchasedPhoneNumberStatuses = phoneNumbers.map(phoneNumber => ({
    status: 'PURCHASED',
    phoneNumber,
  }))
  const twoBatchesOfPhoneNumbers = times(registrationBatchSize + 1, phoneNumberFactory)
  const verifiedStatus = { status: pnStatuses.VERIFIED, phoneNumber }
  const sock = {}
  const db = {}

  let registerStub,
    awaitVerificationStub,
    verifyStub,
    updateStub,
    findAllStub,
    findAllPurchasedStub,
    pathExistsStub,
    logStub

  const updateSucceeds = () =>
    updateStub.callsFake((_, phoneNumber, { status }) => Promise.resolve({ phoneNumber, status }))

  const updateSucceedsOnCall = n =>
    updateStub
      .onCall(n)
      .callsFake((_, phoneNumber, { status }) => Promise.resolve({ phoneNumber, status }))

  const registrationSucceeds = () =>
    registerStub.returns(
      Promise.resolve({
        type: signal.messageTypes.VERIFICATION_REQUIRED,
        data: {
          username: phoneNumber,
        },
      }),
    )

  const verificationSucceeds = () =>
    awaitVerificationStub.returns(
      Promise.resolve({
        type: signal.messageTypes.VERIFICATION_SUCCESS,
        data: {
          username: phoneNumber,
        },
      }),
    )

  const verificationSucceedsOnCall = n =>
    awaitVerificationStub.onCall(n).returns(
      Promise.resolve({
        type: signal.messageTypes.VERIFICATION_SUCCESS,
        data: {
          username: phoneNumber,
        },
      }),
    )

  beforeEach(() => {
    registerStub = sinon.stub(signal, 'register')
    awaitVerificationStub = sinon.stub(signal, 'awaitVerificationResult')
    verifyStub = sinon.stub(signal, 'verify')
    findAllStub = sinon.stub(phoneNumberRepository, 'findAll')
    findAllPurchasedStub = sinon.stub(phoneNumberRepository, 'findAllPurchased')
    updateStub = sinon.stub(phoneNumberRepository, 'update')
    pathExistsStub = sinon.stub(fs, 'pathExists')
    logStub = sinon.stub(logger, 'log')
  })

  afterEach(() => {
    registerStub.restore()
    awaitVerificationStub.restore()
    verifyStub.restore()
    updateStub.restore()
    findAllStub.restore()
    findAllPurchasedStub.restore()
    pathExistsStub.restore()
    logStub.restore()
  })

  describe('registering a number with signal', () => {
    describe('in all cases', () => {
      beforeEach(async () => {
        registerStub.returns(Promise.resolve())
        awaitVerificationStub.returns(Promise.resolve())
        updateStub.returns(Promise.resolve())
      })

      it('attempts to register a phone number', async () => {
        await register({ db, sock, phoneNumber })
        expect(registerStub.callCount).to.eql(1)
      })
    })

    describe('when registration succeeds', () => {
      beforeEach(() => registrationSucceeds())

      it('attempts to record registered status', async () => {
        await register({ db, sock, phoneNumber })
        expect(updateStub.getCall(0).args).to.eql([
          db,
          phoneNumber,
          { status: pnStatuses.REGISTERED },
        ])
      })

      describe('when saving registration status succeeds', () => {
        beforeEach(async () => {
          updateSucceedsOnCall(0)
          awaitVerificationStub.returns(Promise.resolve())
        })

        it('listens for verification result', async () => {
          await register({ db, sock, phoneNumber })
          expect(awaitVerificationStub.callCount).to.eql(1)
        })

        describe('when verification succeeds', () => {
          beforeEach(() => verificationSucceeds())

          it('attempts to save verification status', async () => {
            await register({ db, sock, phoneNumber })
            expect(updateStub.getCall(1).args).to.eql([
              db,
              phoneNumber,
              { status: pnStatuses.VERIFIED },
            ])
          })

          describe('when saving verification status succeeds', () => {
            beforeEach(() => updateSucceedsOnCall(1))

            it('returns a success status', async () => {
              expect(await register({ db, sock, phoneNumber })).to.eql(verifiedStatus)
            })
          })

          describe('when saving verification status fails', () => {
            beforeEach(() =>
              updateStub
                .onCall(1)
                .callsFake(() => Promise.reject(new Error('wild database error!'))),
            )

            it('returns an error status', async () => {
              expect(await register({ db, sock, phoneNumber })).to.eql({
                status: pnStatuses.ERROR,
                phoneNumber,
                error: errors.registrationFailed('Error: wild database error!', phoneNumber),
              })
            })
          })
        })

        describe('when verification fails', () => {
          beforeEach(() => {
            awaitVerificationStub.callsFake(() => Promise.reject(new Error('oh noes!')))
            updateStub.returns(Promise.resolve())
          })

          it('returns an error status', async () => {
            expect(await register({ db, sock, phoneNumber })).to.eql({
              status: pnStatuses.ERROR,
              phoneNumber,
              error: errors.registrationFailed('Error: oh noes!', phoneNumber),
            })
          })
        })
      })

      describe('when recording registration fails', () => {
        beforeEach(() =>
          updateStub.onCall(0).callsFake(() => Promise.reject('wild database error!')),
        )

        it('returns an error status', async () => {
          expect(await register({ db, sock, phoneNumber })).to.eql({
            status: pnStatuses.ERROR,
            phoneNumber,
            error: errors.registrationFailed('wild database error!'),
          })
        })
      })
    })

    describe('when registration fails', () => {
      beforeEach(() => registerStub.callsFake(() => Promise.reject(new Error('foo'))))

      it('returns an error status', async () => {
        expect(await register({ db, sock, phoneNumber })).to.eql({
          status: pnStatuses.ERROR,
          phoneNumber,
          error: errors.registrationFailed('Error: foo'),
        })
      })
    })
  })

  describe('registering many numbers with signal', () => {
    describe('in all cases', () => {
      beforeEach(() => {
        registrationSucceeds()
        verificationSucceeds()
        updateSucceeds()
      })

      it('attempts to register phone numbers in batches', async () => {
        registerMany({ db, sock, phoneNumbers: twoBatchesOfPhoneNumbers })
        await wait(twoBatchesOfPhoneNumbers.length * intervalBetweenRegistrations)
        expect(registerStub.callCount).to.be.at.most(registrationBatchSize)
        await wait(intervalBetweenRegistrations * 2) // to avoid side effects on other tests
      })

      it('waits a set interval between batches and between registrations', async () => {
        const start = new Date().getTime()
        await registerMany({ db, sock, phoneNumbers: twoBatchesOfPhoneNumbers }).catch(a => a)
        const elapsed = new Date().getTime() - start
        expect(elapsed).to.be.above(
          (twoBatchesOfPhoneNumbers.length - 2) * intervalBetweenRegistrations +
            intervalBetweenRegistrationBatches,
        )
      })
    })

    describe('when all registrations succeed', () => {
      // NOTE: we focus on happy path b/c sad path is covered exhaustively above
      beforeEach(() => {
        registrationSucceeds()
        verificationSucceeds()
        updateSucceeds()
      })

      it('returns an array of success pnStatuses', async () => {
        expect(await registerMany({ db, sock, phoneNumbers })).to.eql([
          {
            status: pnStatuses.VERIFIED,
            phoneNumber: phoneNumbers[0],
          },
          {
            status: pnStatuses.VERIFIED,
            phoneNumber: phoneNumbers[1],
          },
          {
            status: pnStatuses.VERIFIED,
            phoneNumber: phoneNumbers[2],
          },
        ])
      })
    })

    describe('when one registration fails', () => {
      beforeEach(() => {
        registrationSucceeds()
        updateSucceeds()
        verificationSucceedsOnCall(0)
        verificationSucceedsOnCall(1)
        awaitVerificationStub
          .onCall(2)
          .callsFake(() => Promise.reject(new Error('verification timed out')))
      })

      it('returns an array of success AND error pnStatuses', async () => {
        expect(await registerMany({ db, sock, phoneNumbers })).to.eql([
          {
            status: pnStatuses.VERIFIED,
            phoneNumber: phoneNumbers[0],
          },
          {
            status: pnStatuses.VERIFIED,
            phoneNumber: phoneNumbers[1],
          },
          {
            status: pnStatuses.ERROR,
            phoneNumber: phoneNumbers[2],
            error: errors.registrationFailed('Error: verification timed out'),
          },
        ])
      })
    })
  })

  describe('registering all unregistered numbers with signal', () => {
    beforeEach(() => {
      findAllStub.returns(Promise.resolve(purchasedPhoneNumberStatuses))
      registrationSucceeds()
      verificationSucceeds()
      updateSucceeds()
    })

    describe('in all cases', () => {
      const twoBatchesOfPhoneNumbers = times(registrationBatchSize + 1, phoneNumberFactory)
      beforeEach(() => {
        findAllStub.returns(Promise.resolve(twoBatchesOfPhoneNumbers))
      })

      it('attempts to register phone numbers in batches', async () => {
        registerAllUnregistered({ db, sock })
        await wait(twoBatchesOfPhoneNumbers.length * intervalBetweenRegistrations)
        expect(registerStub.callCount).to.be.at.most(registrationBatchSize)
        await wait(intervalBetweenRegistrations * 2) // to avoid side effects on other tests
      })

      it('waits a set interval between batches and between registrations', async () => {
        const start = new Date().getTime()
        await registerAllUnregistered({ db, sock }).catch(a => a)
        const elapsed = new Date().getTime() - start
        expect(elapsed).to.be.above(
          (twoBatchesOfPhoneNumbers.length - 2) * intervalBetweenRegistrations +
            intervalBetweenRegistrationBatches,
        )
      })
    })

    describe('when all phone numbers are not registered', () => {
      beforeEach(() => pathExistsStub.returns(Promise.resolve(true)))

      describe('when all registrations succeed', () => {
        // NOTE: we omit sad path tests b/c those are covered exhaustively above
        it('returns an array of success pnStatuses', async () => {
          expect(await registerAllUnregistered({ db, sock })).to.eql([
            {
              status: pnStatuses.VERIFIED,
              phoneNumber: phoneNumbers[0],
            },
            {
              status: pnStatuses.VERIFIED,
              phoneNumber: phoneNumbers[1],
            },
            {
              status: pnStatuses.VERIFIED,
              phoneNumber: phoneNumbers[2],
            },
          ])
        })
      })
    })

    describe('when a phone number is already in the keystore and marked as verified in the db', () => {
      beforeEach(() => {
        registrationSucceeds()
        verificationSucceeds()
        updateSucceeds()
        pathExistsStub.onCall(0).returns(Promise.resolve(false))
        pathExistsStub.onCall(1).returns(Promise.resolve(false))
        pathExistsStub.onCall(2).returns(Promise.resolve(true))
        findAllStub.returns(
          Promise.resolve([
            ...phoneNumbers.slice(0, 2),
            { ...phoneNumbers[2], status: pnStatuses.VERIFIED },
          ]),
        )
      })

      it('does not attempt to register that phone number', async () => {
        await registerAllUnregistered({ db, sock })
        expect(registerStub.callCount).to.eql(2)
      })
    })
  })

  describe('verifying a number with signal', () => {
    const verificationCode = '809-842'

    describe('in all cases', () => {
      beforeEach(async () => {
        verifyStub.returns(Promise.resolve())
        await verify({ sock, phoneNumber, verificationCode })
      })

      it('attempts to verify the code with signal', () => {
        expect(verifyStub.getCall(0).args).to.eql([sock, phoneNumber, '809-842'])
      })
    })

    describe('when sending the verification code succeeds', () => {
      beforeEach(() => verifyStub.returns(Promise.resolve()))

      it('waits for a verification result from signald', async () => {
        await verify({ db, sock, phoneNumber, verificationCode })
        expect(awaitVerificationStub.callCount).to.eql(1)
      })

      describe('when verification succeeds', () => {
        beforeEach(() => verificationSucceeds())

        it('returns the success message from signald', async () => {
          expect(await verify({ db, sock, phoneNumber, verificationCode })).to.eql({
            status: statuses.SUCCESS,
            message: 'OK',
          })
        })
      })

      describe('when verification fails', () => {
        beforeEach(() =>
          awaitVerificationStub.callsFake(() => Promise.reject(new Error('rate limited'))),
        )

        it('returns an error status', async () => {
          expect(await verify({ db, sock, phoneNumber, verificationCode })).to.eql({
            status: pnStatuses.ERROR,
            message: 'rate limited',
          })
        })
      })
    })

    describe('when sending the verification code fails', () => {
      beforeEach(() => verifyStub.callsFake(() => Promise.reject(new Error('weird network error'))))

      it('rejects with an error', async () => {
        expect(await verify({ db, sock, phoneNumber, verificationCode }).catch(a => a)).to.eql({
          status: statuses.ERROR,
          message: 'weird network error',
        })
      })
    })
  })
})
