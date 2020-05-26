/* eslint require-atomic-updates: 0 */
const phoneNumberService = require('./phoneNumber')
const channelRegistrar = require('./channel')
const { get, find, merge } = require('lodash')
const signal = require('../signal')
const {
  twilio: { smsEndpoint },
} = require('../../config/index')

const routesOf = async (router, db, sock) => {
  router.get('/hello', async ctx => {
    ctx.body = { msg: 'hello world' }
  })

  router.get('/healthcheck', async ctx => {
    const result = await signal.isAlive(sock)
    merge(ctx, { status: httpStatusOf(get(result, 'status')) })
  })

  router.get('/channels', async ctx => {
    const result = await channelRegistrar.list(db)
    merge(ctx, { status: httpStatusOf(get(result, 'status')), body: result.data })
  })

  router.post('/channels', async ctx => {
    const { phoneNumber, name, admins } = ctx.request.body
    const result = await channelRegistrar.create({ db, sock, phoneNumber, name, admins })
    merge(ctx, { status: httpStatusOf(get(result, 'status')), body: result })
  })

  router.post('/channels/admins', async ctx => {
    const { channelPhoneNumber, adminPhoneNumber } = ctx.request.body
    const result = await channelRegistrar.addAdmin({
      db,
      sock,
      channelPhoneNumber,
      adminPhoneNumber,
    })
    merge(ctx, { status: httpStatusOf(get(result, 'status')), body: result })
  })

  router.get('/phoneNumbers', async ctx => {
    const filter = phoneNumberService.filters[ctx.query.filter] || null
    const phoneNumberList = await phoneNumberService.list(db, filter)
    merge(ctx, { status: httpStatusOf(phoneNumberList.status), body: phoneNumberList.data })
  })

  router.post('/phoneNumbers', async ctx => {
    const { num, areaCode } = ctx.request.body
    const n = parseInt(num) || 1

    const phoneNumberStatuses = await phoneNumberService.provisionN({ db, sock, areaCode, n })
    merge(ctx, { status: httpStatusOfMany(phoneNumberStatuses), body: phoneNumberStatuses })
  })

  router.delete('/phoneNumbers', async ctx => {
    const { phoneNumber } = ctx.request.body
    const result = await phoneNumberService.destroy({
      db,
      sock,
      phoneNumber,
    })
    merge(ctx, { status: httpStatusOf(result.status), body: result })
  })

  router.post('/phoneNumbers/recycle', async ctx => {
    const { phoneNumbers } = ctx.request.body
    const result = await phoneNumberService.recycle({
      db,
      sock,
      phoneNumbers,
    })
    merge(ctx, { status: httpStatusOfMany(result), body: result })
  })

  router.post(`/${smsEndpoint}`, async ctx => {
    const { To: phoneNumber, Body: smsBody, From: senderPhoneNumber } = ctx.request.body
    const { status, message } = await phoneNumberService.handleSms({
      db,
      sock,
      phoneNumber,
      senderPhoneNumber,
      message: smsBody,
    })
    const header = { 'content-type': 'text/xml' }
    merge(ctx, { status: httpStatusOf(status), body: message, header })
  })
}

// HELPERS

const httpStatusOf = status => (status === phoneNumberService.statuses.ERROR ? 500 : 200)
const httpStatusOfMany = pnStatuses =>
  find(pnStatuses, pns => pns.status === phoneNumberService.statuses.ERROR) ? 500 : 200

module.exports = routesOf
