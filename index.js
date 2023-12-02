const { ethers, Wallet } = require('ethers')
const fetch = require('node-fetch')
const TelegramBot = require('node-telegram-bot-api')
const { createPublicClient, http, createWalletClient } = require('viem')
const { privateKeyToAccount } = require('viem/accounts')
const { base } = require('viem/chains')
const abi = require('./abi.json')
const { default: axios } = require('axios')

const graphQLNode = 'https://api.frenpet.xyz/'
const contractAddress = '0x0e22B5f3E11944578b37ED04F5312Dfc246f443C'

const petQuery = (owner) => `
{
  pets(
    where:{
      owner_in: "${owner}"
    }
  ) {
    id
    score
    lastAttackUsed
  }
}
`
const petQueryById = (id) => `
{
  pet(id: ${id}) {
    id
    score
    lastAttackUsed
  }
}
`
const itemOwnedQuery = (id) => `
{
  pet(id: ${id}) {
    itemsOwned
  }
}
`
const leaderboardQuery = () => `
{
  pets (
    first: 1000,
    skip: 75,
    where: {
      owner_not: "0x0000000000000000000000000000000000000000"
    },
    orderBy: "level",
    orderDirection: "desc"
  ) {
    name
    id
    owner
    score
    timeUntilStarving
    status
    lastAttackUsed
    lastAttacked
    level
  }
}
`

const sleep = async (ms) => {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function getWalletClient() {
    const transport = http(env.NODE_URL)
    return createWalletClient({
        chain: base,
        transport: transport,
    })
}

function getPublicClient() {
    const transport = http(env.NODE_URL)
    return createPublicClient({
        chain: base,
        transport: transport,
    })
}

async function getCommit(petId) {
    const resp = await axios.get(
        `https://frenpet.dievardump.com/api/bonks/commit/${petId}`
    )
    return resp.data.data
}

async function getReveal(petId) {
    const resp = await axios.get(
        `https://frenpet.dievardump.com/api/bonks/reveal/${petId}`
    )
    return resp.data.data
}

const getLeaderboard = async () => {
    const leaderboardResponse = await fetch(graphQLNode, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: leaderboardQuery() }),
    })
    const leaderboardJson = await leaderboardResponse.json()
    const leaderboard = leaderboardJson.data.pets
    return leaderboard
}

require('dotenv').config()
const env = process.env

const main = async () => {
    const telegramToken = env.TELEGRAM_TOKEN
    const telegramChatId = env.TELEGRAM_CHAT_ID
    let bot
    if (telegramToken && telegramChatId) {
        bot = new TelegramBot(telegramToken, { polling: true })
        console.log(`Telegram bot started`)
    }

    const lastAttackedTimestamp = {}

    const web3 = new ethers.providers.JsonRpcProvider(env.NODE_URL)
    const wallet = new Wallet(env.PRIVATE_KEY, web3)

    console.log(`Wallet address: ${wallet.address}`)

    while (true) {
        let pets = []
        try {
            const petsResponse = await fetch(graphQLNode, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ query: petQuery(wallet.address) }),
            })
            const petsJson = await petsResponse.json()
            pets = petsJson.data.pets
        } catch (e) {
            console.log(`Error fetching pets: ${e}`)
        }

        if (pets.length === 0) {
            console.log(`!!! No pets found`)
            await sleep(5000)
            continue
        }

        for (let i = 0; i < pets.length; i++) {
            const pet = pets[i]
            const petId = pet.id
            const petScore = pet.score
            const lastAttackUsed = pet.lastAttackUsed

            // we can attack if last attack was more than 15 minutes ago
            const now = Math.floor(Date.now() / 1000)
            const canAttack = now - lastAttackUsed > 15 * 60
            // -----------------------------------------------------------------------------
            if (!canAttack) {
                console.log(
                    `-> Pet ${petId} cannot attack yet waiting ${
                        15 * 60 - (now - lastAttackUsed)
                    } seconds`
                )
                continue
            }

            if (typeof lastAttackedTimestamp[petId] === 'undefined') {
                lastAttackedTimestamp[petId] = 0
            }
            if (lastAttackedTimestamp[petId] + 15 * 60 > now) {
                console.log(
                    `-> Pet ${petId} already attacked in the last 15 minutes`
                )
                continue
            }

            console.log(`Pet ${petId} can attack!`)

            const leaderboard = await getLeaderboard()
            for (const leaderboardPet of leaderboard) {
                const lastAttacked = leaderboardPet.lastAttacked
                const leaderboardScore = leaderboardPet.score

                if (
                    ethers.BigNumber.from(leaderboardScore).lte(
                        ethers.BigNumber.from(petScore)
                            .mul(ethers.BigNumber.from(15))
                            .div(ethers.BigNumber.from(10))
                    )
                ) {
                    console.log(
                        'skipping pet',
                        leaderboardPet.id,
                        'score is too low'
                    )
                    continue
                }

                const status = leaderboardPet.status
                const now = Math.floor(Date.now() / 1000)
                if (lastAttacked + 60 * 60 < now && status === 0) {
                    const itemsOwnedResponse = await fetch(graphQLNode, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            query: itemOwnedQuery(leaderboardPet.id),
                        }),
                    })
                    const itemsOwnedJson = await itemsOwnedResponse.json()
                    const itemsOwned = itemsOwnedJson.data?.pet.itemsOwned
                    if (!itemsOwned?.includes(6)) {
                        console.log(`Attacking pet ${leaderboardPet.id}`)

                        try {
                            // commit bonk
                            const commitData = await getCommit(petId)
                            console.log('commitData', commitData)

                            const { request, result } =
                                await getPublicClient().simulateContract({
                                    account: privateKeyToAccount(
                                        env.PRIVATE_KEY
                                    ),
                                    address: contractAddress,
                                    abi: abi,
                                    functionName: 'bonkCommit',
                                    args: [
                                        petId,
                                        leaderboardPet.id,
                                        commitData.nonce,
                                        commitData.commit,
                                        commitData.signature,
                                    ],
                                })

                            const tx = await getWalletClient().writeContract(
                                request
                            )
                            await getPublicClient().waitForTransactionReceipt({
                                hash: tx,
                            })
                            console.log(`-> Transaction hash commit: ${tx}`)

                            // reveal bonk
                            const revealData = await getReveal(petId)

                            const { request: request2, result: result2 } =
                                await getPublicClient().simulateContract({
                                    account: privateKeyToAccount(
                                        env.PRIVATE_KEY
                                    ),
                                    address: contractAddress,
                                    abi: abi,
                                    functionName: 'bonkReveal',
                                    args: [petId, revealData.reveal],
                                })

                            const tx2 = await getWalletClient().writeContract(
                                request2
                            )

                            await getPublicClient().waitForTransactionReceipt({
                                hash: tx2,
                            })
                            console.log(`-> Transaction hash reveal: ${tx2}`)

                            // get new score
                            const updatedPetResponse = await fetch(
                                graphQLNode,
                                {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json',
                                    },
                                    body: JSON.stringify({
                                        query: petQueryById(petId),
                                    }),
                                }
                            )
                            const updatedPetJson =
                                await updatedPetResponse.json()
                            console.log('updatedPetJson', updatedPetJson)
                            const updatedPet = updatedPetJson.data.pet
                            const updatedPetScore = updatedPet.score
                            const updatedScore = ethers.BigNumber.from(
                                updatedPetScore
                            ).sub(ethers.BigNumber.from(petScore))
                            const formatedScore = ethers.utils.formatUnits(
                                updatedScore,
                                12
                            )
                            console.log(
                                `-> Pet ${petId} won score: ${formatedScore.toString()}`
                            )
                            if (bot) {
                                bot.sendMessage(
                                    telegramChatId,
                                    `Pet ${petId} won score: ${formatedScore.toString()}`
                                )
                            }
                            lastAttackedTimestamp[petId] = now
                            break
                        } catch (e) {
                            console.log(
                                `-> !!!Error attacking pet ${leaderboardPet.id}: ${e.message}`
                            )
                        }
                    } else {
                        console.log('they have a shield')
                    }
                }
            }
        }

        await sleep(25000)
    }
}

main()
