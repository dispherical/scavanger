require("dotenv").config();
const { App } = require("@slack/bolt");
const { ChatOllama, OllamaEmbeddings } = require("@langchain/ollama");
const { createClient } = require("redis");
const { Document } = require("@langchain/core/documents");
const { RedisVectorStore } = require("@langchain/redis");
const { ChatPromptTemplate } = require("@langchain/core/prompts");
const { createRetrievalChain } = require("langchain/chains/retrieval");
const { createStuffDocumentsChain } = require("langchain/chains/combine_documents");
const { randomUUID } = require("node:crypto");
const { TokenTextSplitter } = require("langchain/text_splitter")
const userLastExecution = {};

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: !Boolean(process.env.PORT),
    appToken: process.env.SLACK_APP_TOKEN,
    port: process.env.PORT
});

const embeddings = new OllamaEmbeddings({
    model: "mxbai-embed-large:latest",
    maxRetries: 0
});

const textSplitter = new TokenTextSplitter({
    chunkSize: 100,
    chunkOverlap: 20,
});

let llm = new ChatOllama({
    model: "llama3.2:3b",
    temperature: 0,
    maxRetries: 0,
});

(async () => {
    const client = await createClient({
        url: process.env.REDIS_DATABASE,
    })
        .on("error", (err) => console.error("Redis Client Error", err))
        .connect();

    var messages = (
        await client.lRange(
            `${process.env.INSTANCE_ID || "production"}.messageCache`,
            0,
            -1,
        )
    ).map((obj) => JSON.parse(obj));

    const vectorStore = new RedisVectorStore(embeddings, {
        redisClient: client,
        indexName: "langchainjs-testing",
    });

    console.log("Loaded messages from Redis.");
    messages = messages.reverse().filter(msg => msg.text).slice(-100);
    const channels = await (await fetch("http://l.hack.club/channels")).json();
    console.log("Loaded channel database.");
    var documents = [];
    messages.forEach(msg => {
        var channel = channels.find(channel => channel.id == msg.channel);
        if (!channel) return
        if (!msg.text) return;
        documents.push(new Document({
            id: randomUUID(),
            pageContent: `TEXT: ${msg.text}
--- METADATA ---
DATE: ${new Date(msg.ts * 1000.0).toISOString()}
CHANNEL: #${channel?.name || msg.channel}
--- METADATA END ---`.trim(),
            metadata: { user: msg.user, date: new Date(msg.ts * 1000.0).toISOString(), channel_name: `#${channel?.name || msg.channel}` },
        }));
    });
    console.log("Loaded messages as documents.");
    documents = await textSplitter.splitDocuments(documents)
    console.log("Split messages into max token documents.")
    await vectorStore.delete({ deleteAll: true });
    console.log("Deleted previous vectorStore");
    console.log(`Adding ${documents.length} documents to Redis`)
    await vectorStore.addDocuments(documents);
    console.log("Added documents to vector.");

    const retriever = vectorStore.asRetriever();
    const systemTemplate = `You are given every message in the Hack Club Slack for the past 12 hours. Your job is to help the user find ongoing and interesting conversations to help them find what people are talking about in Hack Club. Be very welcoming, friendly, and use emojis. See if you can find 5-8 cool conversations, Feel free to go into as much detail as you want but don't make up channels.\n\n{context}`;

    const prompt = ChatPromptTemplate.fromMessages([
        ["system", systemTemplate],
        ["human", "{input}"],
    ]);
    const questionAnswerChain = await createStuffDocumentsChain({
        llm,
        prompt,
    });
    const ragChain = await createRetrievalChain({
        retriever,
        combineDocsChain: questionAnswerChain,
    });

    setInterval(async function () {
        messages = (
            await client.lRange(
                `${process.env.INSTANCE_ID || "production"}.messageCache`,
                0,
                -1,
            )
        ).map((obj) => JSON.parse(obj));
        messages = messages.reverse().filter(msg => msg.text).slice(-100);
        console.log("Loaded new messages");
        messages.forEach(msg => {
            var channel = channels.find(channel => channel.id == msg.channel);
            if (!msg.text) return;

            documents.push(new Document({
                id: randomUUID(),
                pageContent: `${msg.text}
--- METADATA ---
DATE: ${new Date(msg.ts * 1000.0).toISOString()}
CHANNEL: #${channel?.name || msg.channel}
${msg.thread_ts ? `THREAD ID: ${msg.thread_ts}
--- METADATA ---` : ""}`.trim(),
                metadata: { user: msg.user, date: new Date(msg.ts * 1000.0).toISOString(), channel_name: `#${channel?.name || msg.channel}` },
            }));
        });
        await vectorStore.delete({ deleteAll: true });
        console.log("Deleted previous vectorStore");
        await vectorStore.addDocuments(documents);
        console.log("Added documents to vector.");
    }, 1000 * 60 * 5 * 9);

    async function regenerate() {
        console.log("Generating /whatsgoingon...");
        global.whatsgoingon = (await ragChain.invoke({
            input: `You are given a vector database of the most recent messages in the Hack Club Slack. Give the user an overview of all of the conversations going on with the Slack with no followup questions. Give the channel name, number of active users, key topics being discussed, and key takeaways or conclusions from the discussions based on those messages and ONLY those messages. They have been properly filtered. Use emojis during your message, be friendly, and make it easy to read for someone who may not speak the best English. DO NOT FAKE CHANNELS. DO NOT MAKE UP CHANNELS. CHANNELS SHOULD ONLY BE THE ONES GIVEN SPECIFIED IN THE METADATA.`,
        })).answer.replaceAll("**", "");
        console.log("Generated /whatsgoingon");
    }

    setInterval(regenerate, 1000 * 60 * 5);
    regenerate();

    app.command("/whatsgoingon", async ({ command, body, ack, respond }) => {
        await ack();
        if (!global.whatsgoingon) return await respond("The global digest is still generating. Try again in 1 minute.")
        await respond(global.whatsgoingon.replaceAll("**", "").replaceAll("<#", "").replaceAll(">", "").replace(/\b[C|G][A-Z0-9]{8,}\b/g, (match) => `<#${match}>`));
    });

    app.command("/prompt", async ({ command, body, ack, respond }) => {
        const userId = body.user_id;
        await ack();
        if (!command.text) return await respond("Give me a question and I'll respond!");
        var rateLimit = 60 * 1000;
        const currentTime = Date.now();
        if (userLastExecution[userId] && (currentTime - userLastExecution[userId] < rateLimit) && !process.env.WHITELIST.includes(command.user_id)) {
            await respond("You are being rate limited. Please wait a minute before trying again.");
            return;
        }
        userLastExecution[userId] = currentTime;
        await respond(":spin-loading: Generating your response. This can take a while.");
        await respond((await ragChain.invoke({
            input: command.text,
        })).answer.replaceAll("**", "").replaceAll("<#", "").replaceAll(">", "").replace(/\b[C|G][A-Z0-9]{8,}\b/g, (match) => `<#${match}>`));
    });

    app.command("/channeldigest", async ({ command, body, ack, respond }) => {
        await ack();
        await respond(":spin-loading: Generating your summary for this channel. This may take up to a minute");
        try {
            await app.client.conversations.join({
                channel: command.channel_id
            })
        } catch (e) {
            console.error(e)
        }
        let history = await app.client.conversations.history({
            channel: command.channel_id
        })

        let docs = []
        history.messages.forEach(msg => {
            docs.push(new Document({
                id: randomUUID(),
                pageContent: `${msg.text}
--- METADATA ---
DATE: ${new Date(msg.ts * 1000.0).toISOString()}
${msg.thread_ts ? `THREAD ID: ${msg.thread_ts}` : ""}
--- METADATA ---`
            }))
        })
        const localVectorStore = new RedisVectorStore(new OllamaEmbeddings({
            model: "mxbai-embed-large:latest",
            maxRetries: 0
        }), {
            redisClient: client,
            indexName: "localvectorstore",
        });
        await localVectorStore.delete({ deleteAll: true });
        docs = await textSplitter.splitDocuments(docs)
        await localVectorStore.addDocuments(docs)
        const userId = body.user_id;
        const currentTime = Date.now();
        var rateLimit = 60 * 1000;
        if (userLastExecution[userId] && (currentTime - userLastExecution[userId] < rateLimit)) {
            await respond("You are being rate limited. Please wait a minute before trying again.");
            return;
        }
        userLastExecution[userId] = currentTime;
        var ret = localVectorStore.asRetriever()
        const localRagChain = await createRetrievalChain({
            retriever: ret,
            combineDocsChain: questionAnswerChain,
        });
        var channel = channels.find(channel => channel.id == command.channel_id);

        await respond((await localRagChain.invoke({
            input: `You are given the messages for ${channel.name || command.channel_id} (${command.channel_id}). With those messages, make me a daily digest. Make it somewhat lengthy but easy to digest. Include all of the details and recent talking points.`,
        })).answer.replaceAll("**", "").replaceAll("<#", "").replaceAll(">", "").replace(/\b[C|G][A-Z0-9]{8,}\b/g, (match) => `<#${match}>`));
    });

    await app.start();
    console.log("Started.");
})();