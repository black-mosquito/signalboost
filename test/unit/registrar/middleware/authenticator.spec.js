import { describe, it, before, after, beforeEach, afterEach } from 'mocha'
import sinon from 'sinon'
import twilio from 'twilio'
import request from 'supertest'
import phoneNumberService from '../../../../app/registrar/phoneNumber'
import { run } from '../../../../app/api'
import app from '../../../../app'
import testApp from '../../../support/testApp'
import { EventEmitter } from 'events'
import { statuses } from '../../../../app/util'
const {
  api: { authToken },
} = require('../../../../app/config')

describe('authentication middleware', () => {
  let server

  before(async () => {
    const sock = new EventEmitter()
    sock.write = sinon.stub()
    server = (await app.run({ ...testApp, api: { run: () => run(10000, {}, sock) } })).api.server
  })

  after(() => {
    sinon.restore()
    server.close()
  })

  describe('for api endpoints', () => {
    it('allows a request that contains auth token in the header', async () => {
      await request(server)
        .get('/hello')
        .set('Token', authToken)
        .expect(200, { msg: 'hello world' })
    })

    it('allows a request regardless of cregistrartalization in header', async () => {
      await request(server)
        .get('/hello')
        .set('ToKeN', authToken)
        .expect(200, { msg: 'hello world' })
    })

    it('blocks a request that does not contain an auth token in the header', async () => {
      await request(server)
        .get('/hello')
        .expect(401, { error: 'Not Authorized' })
    })

    it('blocks a request that contains the wrong auth token in the header', async () => {
      await request(server)
        .get('/hello')
        .set('Token', 'foobar')
        .expect(401, { error: 'Not Authorized' })
    })

    it('blocks a request that contains the right auth token in the wrong header', async () => {
      await request(server)
        .get('/hello')
        .set('FooBar', authToken)
        .expect(401, { error: 'Not Authorized' })
    })
  })

  describe('for twilio callback endpoint', () => {
    let validateSignatureStub

    beforeEach(() => {
      validateSignatureStub = sinon.stub(twilio, 'validateRequest')
      sinon
        .stub(phoneNumberService, 'handleSms')
        .returns(Promise.resolve({ status: statuses.SUCCESS, message: 'OK' }))
    })

    afterEach(() => {
      sinon.restore()
    })

    it('blocks a request to the twilio endpoint that lacks a valid signature', async () => {
      validateSignatureStub.returns(false)
      await request(server)
        .post('/twilioSms')
        .expect(401, { error: 'Not Authorized' })
    })

    it('accepts a request to the twilio endpoint that contains a valid signature', async () => {
      validateSignatureStub.returns(true)
      await request(server)
        .post('/twilioSms')
        .expect(200)
    })
  })

  describe('for /metrics endpoint', () => {
    it('allows a request that contains an auth bearer token in the header', async () => {
      await request(server)
        .get('/metrics')
        .set('Authorization', 'bearer ' + authToken)
        .expect(200)
    })

    it('does not allow a request that does not contain an auth bearer token in the header', async () => {
      await request(server)
        .get('/metrics')
        .expect(401)
    })
  })
})
