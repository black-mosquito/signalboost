const defaults = {
  verificationTimeout: 30000, // 30 seconds
  keystorePath: '/var/lib/signald/data', // given by docker-compose file(s)
  connectionInterval: 1000, // 1 sec
  maxConnectionAttempts: 30, // 30 tries/ 30 seconds
  registrationBatchSize: 5,
  trustRequestTimeout: 10000, // 10 sec
  intervalBetweenRegistrationBatches: 120000, // 2 minutes
  intervalBetweenRegistrations: 2000, // 2 seconds
  signaldStartupTime: 1000 * 60 * 5, // 5 minutes
  welcomeDelay: 3000, // 3 sec
  signupPhoneNumber: process.env.SIGNUP_CHANNEL_NUMBER,
  defaultMessageExpiryTime: 60 * 60 * 24, // 1 week
  expiryUpdateDelay: 200, // 200 millis
  minResendInterval: 2000, // 2 seconds
  maxResendInterval: 256000, // 256 seconds / ~4.25 minutes
}

const test = {
  ...defaults,
  verificationTimeout: 30, // 30 millis
  connectionInterval: 10, // 10 milli
  maxConnectionAttempts: 10,
  trustRequestTimeout: 100, // 100 millis
  intervalBetweenRegistrationBatches: 30, // 100 millis
  intervalBetweenRegistrations: 5, // 10 millis,
  signaldStartupTime: 1, // 1 milli
  welcomeDelay: 0.0001, // .0001 millis
  signupPhoneNumber: '+15555555555',
  expiryUpdateDelay: 1, // 1 milli
  minResendInterval: 2, // 20 millis
  maxResendInterval: 256, // ~ 2.5 sec
}

const development = {
  ...defaults,
  signupPhoneNumber: process.env.SIGNUP_CHANNEL_NUMBER_DEV,
}

module.exports = {
  development,
  test,
  production: defaults,
}
