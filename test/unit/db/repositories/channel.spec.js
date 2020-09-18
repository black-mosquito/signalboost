import { expect } from 'chai'
import { describe, it, before, beforeEach, after, afterEach } from 'mocha'
import { channelFactory, deepChannelFactory } from '../../../support/factories/channel'
import { genPhoneNumber } from '../../../support/factories/phoneNumber'
import { omit, keys, times, map } from 'lodash'
import channelRepository, { isSysadmin } from '../../../../app/db/repositories/channel'
import app from '../../../../app'
import testApp from '../../../support/testApp'
import dbService from '../../../../app/db'
import { wait } from '../../../../app/util'
import { membershipFactory } from '../../../support/factories/membership'
import * as phoneNumberRegistrar from '../../../../app/registrar/phoneNumber'
const {
  signal: { supportPhoneNumber },
} = require('../../../../app/config')

describe('channel repository', () => {
  const channelPhoneNumber = genPhoneNumber()
  const adminPhoneNumbers = [genPhoneNumber(), genPhoneNumber()]
  let db, channel

  before(async () => {
    db = (await app.run({ ...testApp, db: dbService })).db
  })
  afterEach(async () => {
    await Promise.all([
      db.recycleRequest.destroy({ where: {} }),
      db.membership.destroy({ where: {}, force: true }),
      db.messageCount.destroy({ where: {}, force: true }),
      db.invite.destroy({ where: {}, force: true }),
      db.deauthorization.destroy({ where: {}, force: true }),
    ])
    await db.channel.destroy({ where: {}, force: true })
  })
  after(async () => await app.stop())

  describe('#create', () => {
    let channel, channelCount, messageCountCount, membershipCount

    describe('when given phone number for a non-existent channel and two admins', () => {
      beforeEach(async () => {
        channelCount = await db.channel.count()
        messageCountCount = await db.messageCount.count()
        membershipCount = await db.membership.count()
        channel = await channelRepository.create(channelPhoneNumber, '#blackops', adminPhoneNumbers)
      })

      it('creates a new channel', async () => {
        expect(await db.channel.count()).to.eql(channelCount + 1)
      })

      it('creates an empty messageCount record for the channel', async () => {
        expect(await db.messageCount.count()).to.eql(messageCountCount + 1)
        expect(
          await db.messageCount.findOne({
            where: { channelPhoneNumber: channel.phoneNumber },
          }),
        ).to.be.an('object')
      })

      it('creates two publication records', async () => {
        expect(await db.membership.count()).to.eql(membershipCount + 2)
      })

      it('returns the channel record', () => {
        expect(channel.phoneNumber).to.eql(channelPhoneNumber)
        expect(channel.name).to.eql('#blackops')
        expect(channel.hotlineOn).to.eql(true)
        expect(channel.memberships.map(m => m.memberPhoneNumber)).to.eql(adminPhoneNumbers)
        expect(channel.messageCount).to.be.an('object')
      })
    })

    describe('when given phone number for a already-existing channel', () => {
      let newAdminPhoneNumbers = times(2, genPhoneNumber)
      beforeEach(async () => {
        await channelRepository.create(channelPhoneNumber, '#foursquare', newAdminPhoneNumbers)
        channelCount = await db.channel.count()
        messageCountCount = await db.messageCount.count()
        membershipCount = await db.membership.count()
        channel = await channelRepository.create(
          channelPhoneNumber,
          '#blackops',
          newAdminPhoneNumbers,
        )
      })

      it('does not create a new channel', async () => {
        expect(await db.channel.count()).to.eql(channelCount)
      })

      it('does not create a new messageCount record', async () => {
        expect(await db.messageCount.count()).to.eql(messageCountCount)
      })

      it('updates the channel record and returns it', async () => {
        expect(channel.phoneNumber).to.eql(channelPhoneNumber)
        expect(channel.name).to.eql('#blackops')
        expect(channel.hotlineOn).to.eql(true)
        expect((await channel.memberships).map(m => m.memberPhoneNumber)).to.have.members(
          newAdminPhoneNumbers,
        )
      })
    })
  })

  describe('#update', () => {
    let updatedChannel
    beforeEach(async () => {
      await db.channel.create({ phoneNumber: channelPhoneNumber, name: 'foo' })
      updatedChannel = await channelRepository.update(channelPhoneNumber, { name: 'bar' })
    })

    it("updates a channel's name", async () => {
      const newName = await db.channel
        .findOne({ where: { phoneNumber: channelPhoneNumber } })
        .then(ch => ch.name)
      expect(newName).to.eql('bar')
    })

    it('returns a channel resources with updated values', () => {
      expect(updatedChannel.name).to.eql('bar')
    })
  })

  describe('#destroy', () => {
    let channel, channelCount

    describe('when given the phone number for an existing channel', () => {
      beforeEach(async () => {
        channel = await db.channel.create(deepChannelFactory(), {
          include: [{ model: db.membership }],
        })
      })

      it('deletes the instance and its associations', async () => {
        channelCount = await db.channel.count()
        expect(await channelRepository.destroy(channel.phoneNumber)).to.eql(true)
        expect(await db.channel.count()).to.eql(channelCount - 1)
        expect(await db.membership.findOne({ where: { channelPhoneNumber: channel.phoneNumber } }))
          .to.be.null
      })
    })

    describe('when given the phone number for a non-existent channel', () => {
      it('does nothing', async () => {
        channelCount = await db.channel.count()
        expect(await channelRepository.destroy(genPhoneNumber())).to.eql(false)
        expect(await db.channel.count()).to.eql(channelCount)
      })
    })
  })

  describe('#findDeep', () => {
    const attrs = deepChannelFactory()
    let result

    describe("when channel's associons have values", () => {
      beforeEach(async () => {
        channel = await db.channel.create(attrs, {
          include: [
            { model: db.deauthorization },
            { model: db.invite },
            { model: db.membership },
            { model: db.messageCount },
            { model: db.recycleRequest },
          ],
        })
        result = await channelRepository.findDeep(channel.phoneNumber)
      })

      it("retrieves all of a channel's fields", () => {
        expect(result.phoneNumber).to.eql(channel.phoneNumber)
        expect(result.name).to.eql(channel.name)
      })

      it("retrieves all of a channel's nested attributes", () => {
        expect(result.deauthorizations.length).to.eql(attrs.deauthorizations.length)
        expect(result.invites.length).to.eql(attrs.invites.length)
        expect(result.memberships.length).to.eql(attrs.memberships.length)
        expect(omit(result.messageCount.dataValues, ['createdAt', 'updatedAt'])).to.eql(
          attrs.messageCount,
        )
        expect(result.recycleRequest.channelPhoneNumber).to.eql(channel.phoneNumber)
      })
    })

    describe("when channel's associations are empty", () => {
      beforeEach(async () => {
        channel = await db.channel.create(channelFactory(), {
          include: [
            { model: db.deauthorization },
            { model: db.invite },
            { model: db.membership },
            { model: db.messageCount },
            { model: db.recycleRequest },
          ],
        })
        result = await channelRepository.findDeep(channel.phoneNumber)
      })

      it("retrieves empty values for channel's nested attributes", () => {
        expect(result.deauthorizations).to.eql([])
        expect(result.invites).to.eql([])
        expect(result.memberships).to.eql([])
        expect(result.messageCount).to.be.null
        expect(result.recycleRequest).to.be.null
      })
    })
  })

  describe('#findAllDeep', () => {
    const attrs = [deepChannelFactory(), deepChannelFactory()]
    let channels
    beforeEach(async () => {
      await Promise.all(
        attrs.map(x =>
          db.channel.create(x, {
            include: [
              { model: db.deauthorization },
              { model: db.invite },
              { model: db.membership },
              { model: db.messageCount },
              { model: db.recycleRequest },
            ],
          }),
        ),
      )
      channels = await channelRepository.findAllDeep(db)
    })

    it('fetches each channel', () => {
      expect(channels.length).to.eql(attrs.length)
    })

    it('fetches all attributes and nested resources for each channel', () => {
      channels.forEach(ch => {
        expect(keys(ch.toJSON())).to.eql([
          'phoneNumber',
          'name',
          'description',
          'messageExpiryTime',
          'hotlineOn',
          'vouchMode',
          'vouchLevel',
          'createdAt',
          'updatedAt',
          'deauthorizations',
          'invites',
          'memberships',
          'messageCount',
          'recycleRequest',
        ])
      })
    })
  })

  describe('#findManyDeep', () => {
    const includedPhoneNumbers = times(2, genPhoneNumber)
    const excludesPhoneNumbers = times(3, genPhoneNumber)

    beforeEach(async () => {
      await Promise.all(
        [...includedPhoneNumbers, ...excludesPhoneNumbers].map(phoneNumber =>
          db.channel.create(deepChannelFactory({ phoneNumber }), {
            include: [{ model: db.membership }],
          }),
        ),
      )
    })
    it('retrieves all channels with given phone numbers', async () => {
      const results = await channelRepository.findManyDeep(includedPhoneNumbers)
      expect(map(results, 'phoneNumber')).to.have.members(includedPhoneNumbers)
      expect(results[0].memberships).not.to.be.empty
    })
  })

  describe('#isSysadmin', () => {
    let supportChannel, adminPhoneNumber, subscriberPhoneNumber

    beforeEach(async () => {
      supportChannel = await db.channel.create(
        deepChannelFactory({ phoneNumber: supportPhoneNumber }),
        {
          include: [{ model: db.membership }],
        },
      )
      adminPhoneNumber = supportChannel.memberships[0].memberPhoneNumber
      subscriberPhoneNumber = supportChannel.memberships[2].memberPhoneNumber
    })

    it('returns true for an admin for the support channel', async () => {
      expect(await isSysadmin(adminPhoneNumber)).to.eql(true)
    })

    it('returns false for a subscriber to the support channel', async () => {
      expect(await isSysadmin(subscriberPhoneNumber)).to.eql(false)
    })

    it('returns false for a random number', async () => {
      expect(await isSysadmin(genPhoneNumber())).to.eql(false)
    })
  })
})
