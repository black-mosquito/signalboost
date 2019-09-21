const { Op } = require('sequelize/types')

const run = async db => {
  const numbersWithCounts = await db.messageCount.findAll().map(mc => mc.channelPhoneNumber)

  const numbersWithoutCounts = await db.channel
    .findAll({
      where: {
        phoneNumber: {
          [Op.notIn]: numbersWithCounts,
        },
      },
    })
    .map(ch => ch.phoneNumber)

  if (numbersWithoutCounts.length == 0) {
    console.log('no message counts needed or created.')
    return
  }
  console.log(`creating message counts for ${numbersWithoutCounts}...`)

  await db.messageCount.bulkCreate(
    numbersWithoutCounts.map(channelPhoneNumber => ({
      channelPhoneNumber,
      broadcastIn: 0,
      broadcastOut: 0,
      commandIn: 0,
      commandOut: 0,
    })),
  )
  console.log(`created message counts!`)
}