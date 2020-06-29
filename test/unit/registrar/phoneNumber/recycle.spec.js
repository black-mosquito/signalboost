import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { enqueueRecycleablePhoneNumber, recycle } from '../../../../app/registrar/phoneNumber'
import sinon from 'sinon'
import phoneNumberRepository from '../../../../app/db/repositories/phoneNumber'
import channelRepository from '../../../../app/db/repositories/channel'
import eventRepository from '../../../../app/db/repositories/event'
import signal from '../../../../app/signal'
import common from '../../../../app/registrar/phoneNumber/common'
import { eventTypes } from '../../../../app/db/models/event'

describe('phone number services -- recycle module', () => {
  const phoneNumbers = ['+11111111111', '+12222222222']
  let updatePhoneNumberStub,
    broadcastMessageStub,
    findChannelStub,
    getAdminPhoneNumbersStub,
    destroyChannelSpy,
    notifyMaintainersStub,
    logEventStub

  beforeEach(() => {
    updatePhoneNumberStub = sinon.stub(phoneNumberRepository, 'update')
    broadcastMessageStub = sinon.stub(signal, 'broadcastMessage')
    findChannelStub = sinon.stub(channelRepository, 'findDeep')
    sinon.stub(channelRepository, 'getMemberPhoneNumbers')
    getAdminPhoneNumbersStub = sinon.stub(channelRepository, 'getAdminPhoneNumbers')
    destroyChannelSpy = sinon.spy()
    logEventStub = sinon.stub(eventRepository, 'log')
  })

  afterEach(() => {
    sinon.restore()
  })

  const updatePhoneNumberSucceeds = () =>
    updatePhoneNumberStub.callsFake((phoneNumber, { status }) =>
      Promise.resolve({ phoneNumber, status }),
    )

  const updatePhoneNumberFails = () =>
    updatePhoneNumberStub.callsFake(() =>
      Promise.resolve({
        then: () => {
          throw 'DB phoneNumber update failure'
        },
      }),
    )

  const destroyChannelSucceeds = () =>
    findChannelStub.callsFake(phoneNumber =>
      Promise.resolve({ destroy: destroyChannelSpy, phoneNumber }),
    )

  const destroyChannelFails = () =>
    findChannelStub.callsFake(phoneNumber =>
      Promise.resolve({
        destroy: () => {
          throw 'Failed to destroy channel'
        },
        phoneNumber,
      }),
    )

  const broadcastMessageSucceeds = () => broadcastMessageStub.callsFake(() => Promise.resolve())

  const broadcastMessageFails = () =>
    broadcastMessageStub.callsFake(() => Promise.reject('Failed to broadcast message'))

  describe('recycling phone numbers', () => {
    describe('when the phone number does not belong to a valid channel', () => {
      beforeEach(async () => {
        findChannelStub.returns(Promise.resolve(null))
      })

      it('returns a channel not found status', async () => {
        const response = await recycle(phoneNumbers[0])
        expect(response).to.eql({
          message: 'Channel not found for +11111111111',
          status: 'ERROR',
        })
      })
    })

    describe('when the phone number does belong to a valid channel', () => {
      beforeEach(async () => {
        findChannelStub.returns(Promise.resolve({}))
      })

      describe('when notifying members of channel recycling fails', () => {
        beforeEach(async () => {
          await broadcastMessageFails()
          notifyMaintainersStub = sinon.stub(common, 'notifyMaintainers')
        })

        afterEach(() => {
          notifyMaintainersStub.restore()
        })

        it('returns a failed status', async () => {
          const response = await recycle(phoneNumbers[0])

          expect(response).to.eql({
            message:
              'Failed to recycle channel for +11111111111. Error: Failed to broadcast message',
            status: 'ERROR',
          })
        })
      })

      describe('when notifying members of channel recycling succeeds', () => {
        beforeEach(async () => {
          await broadcastMessageSucceeds()
        })

        describe('when the channel destruction succeeds', () => {
          beforeEach(() => {
            destroyChannelSucceeds()
          })

          describe('when the phoneNumber update succeeds', () => {
            beforeEach(() => {
              updatePhoneNumberSucceeds()
            })

            it('notifies the members of the channel of destruction', async () => {
              await recycle(phoneNumbers[0])

              expect(broadcastMessageStub.callCount).to.eql(1)
            })

            it('adds a CHANNEL_DESTROYED event to the event log', async () => {
              await phoneNumberService.recycle({ phoneNumbers })
              expect(logEventStub.getCalls().map(call => call.args)).to.have.deep.members(
                phoneNumbers
                  .split(',')
                  .map(phoneNumber => [eventTypes.CHANNEL_DESTROYED, phoneNumber]),
              )
            })

            it('updates the phone number record to verified', async () => {
              await recycle(phoneNumbers[0])

              expect(updatePhoneNumberStub.getCall(0).args).to.eql([
                '+11111111111',
                { status: 'VERIFIED' },
              ])
            })

            it('successfully destroys the channel', async () => {
              await recycle(phoneNumbers[0])

              expect(destroyChannelSpy.callCount).to.eql(1)
            })

            it('returns successful recycled phone number statuses', async () => {
              const response = await recycle(phoneNumbers[0])

              expect(response).to.eql({
                data: {
                  phoneNumber: '+11111111111',
                  status: 'VERIFIED',
                },
                status: 'SUCCESS',
              })
            })
          })

          describe('when the phoneNumber status update fails', () => {
            beforeEach(() => {
              updatePhoneNumberFails()
            })

            it('returns a failed status', async () => {
              const response = await recycle(phoneNumbers[0])

              expect(response).to.eql({
                message:
                  'Failed to recycle channel for +11111111111. Error: DB phoneNumber update failure',
                status: 'ERROR',
              })
            })
          })
        })
      })

      describe('when the channel destruction fails', () => {
        beforeEach(() => {
          destroyChannelFails()
          getAdminPhoneNumbersStub.returns(['+16154804259', '+12345678910'])
        })

        it('notifies the correct instance maintainers', async () => {
          await recycle(phoneNumbers[0])

          expect(broadcastMessageStub.getCall(1).args[0]).to.eql(['+16154804259', '+12345678910'])
        })

        it('notifies the instance maintainers with a channel failure message', async () => {
          await recycle(phoneNumbers[0])

          expect(broadcastMessageStub.getCall(1).args[1]).to.eql({
            messageBody: 'Failed to recycle channel for phone number: +11111111111',
            type: 'send',
            username: '+15555555555',
          })
        })

        it('returns a failed status', async () => {
          const response = await recycle(phoneNumbers[0])

          expect(response).to.eql({
            message: 'Failed to recycle channel for +11111111111. Error: Failed to destroy channel',
            status: 'ERROR',
          })
        })
      })
    })
  })
})
