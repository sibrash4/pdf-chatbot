import { ChatWindowMessage } from "@/schema/ChatWindowMessage";

import { Voy as VoyClient } from "voy-search";

import * as pdf from "pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js";
import type { TextItem } from "pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js";

import { HuggingFaceTransformersEmbeddings } from "langchain/embeddings/hf_transformers";
import { VoyVectorStore } from "langchain/vectorstores/voy";
import { ChatOllama } from "langchain/chat_models/ollama";
import { Document } from "langchain/document";
import { ChatPromptTemplate, MessagesPlaceholder, PromptTemplate } from "langchain/prompts";
import { BaseLanguageModel } from "langchain/base_language";
import { BaseRetriever } from "langchain/schema/retriever";
import { RunnableSequence } from "langchain/schema/runnable";
import { StringOutputParser } from "langchain/schema/output_parser";
import { AIMessage, BaseMessage, HumanMessage } from "langchain/schema";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";


const embeddings = new HuggingFaceTransformersEmbeddings({
  modelName: "Xenova/all-MiniLM-L6-v2",
});

const voyClient = new VoyClient();
const vectorstore = new VoyVectorStore(voyClient, embeddings);
const ollama = new ChatOllama({
  baseUrl: "http://localhost:11435"
});

const REPHRASE_QUESTION_TEMPLATE = `Given the following conversation and a follow up question, rephrase the follow up question to be a standalone question.

Chat History:
{chat_history}
Follow Up Input: {question}
Standalone Question:`;

const rephraseQuestionChainPrompt = PromptTemplate.fromTemplate(REPHRASE_QUESTION_TEMPLATE);

const RESPONSE_SYSTEM_TEMPLATE = `You are an experienced researcher, expert at interpreting and answering questions based on provided sources. Using the provided context, answer the user's question to the best of your ability using the resources provided.
Generate a comprehensive and informative answer (but no more than 80 words) for a given question based solely on the provided search results (URL and content). You must only use information from the provided search results. Use an unbiased and journalistic tone. Combine search results together into a coherent answer. Do not repeat text.
If there is nothing in the context relevant to the question at hand, just say "Hmm, I'm not sure." Don't try to make up an answer.
Anything between the following \`context\` html blocks is retrieved from a knowledge bank, not part of the conversation with the user.
<context>
    {context}
<context/>

REMEMBER: If there is no relevant information within the context, just say "Hmm, I'm not sure." Don't try to make up an answer. Anything between the preceding 'context' html blocks is retrieved from a knowledge bank, not part of the conversation with the user.`;

const responseChainPrompt = ChatPromptTemplate.fromPromptMessages<{context: string, chat_history: BaseMessage[], question: string}>([
  ["system", RESPONSE_SYSTEM_TEMPLATE],
  new MessagesPlaceholder("chat_history"),
  ["user", `{question}`],
]);

const formatDocs = (docs: Document[]) => {
  return docs.map((doc, i) => `<doc id='${i}'>${doc.pageContent}</doc>`).join('\n');
}

const createRetrievalChain = (llm: BaseLanguageModel, retriever: BaseRetriever, chatHistory: ChatWindowMessage[]) => {
  if (chatHistory.length) {
    return RunnableSequence.from([
      rephraseQuestionChainPrompt,
      llm,
      new StringOutputParser(),
      retriever,
      formatDocs,
    ]);
  } else {
    return RunnableSequence.from([
      (input) => input.question,
      retriever,
      formatDocs,
    ]);
  }
}

const embedPDF = async (pdfDataUrl: string) => {
  const parsedPdf = await pdf.getDocument({
    data: atob(pdfDataUrl.split(",")[1]),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  const meta = await parsedPdf.getMetadata().catch(() => null);

  const documents: Document[] = [];

  for (let i = 1; i <= parsedPdf.numPages; i += 1) {
    const page = await parsedPdf.getPage(i);
    const content = await page.getTextContent();

    if (content.items.length === 0) {
      continue;
    }

    const text = content.items
      .map((item) => (item as TextItem).str)
      .join("\n");

    documents.push(
      new Document({
        pageContent: text,
        metadata: {
          pdf: {
            version: pdf.version,
            info: meta?.info,
            metadata: meta?.metadata,
            totalPages: parsedPdf.numPages,
          },
          loc: {
            pageNumber: i,
          },
        },
      })
    );
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 500,
    chunkOverlap: 50,
  });

  const docs = await splitter.splitDocuments(documents)

  self.postMessage({
    type: "log",
    data: docs,
  });

  await vectorstore.addDocuments(docs);
};

const queryVectorStore = async (messages: ChatWindowMessage[]) => {
  const text = messages[messages.length - 1].content;
  const chatHistory: ChatWindowMessage[] = messages.slice(0, -1);

  const retrievalChain = createRetrievalChain(ollama, vectorstore.asRetriever(), chatHistory);
  const responseChain = RunnableSequence.from([
    responseChainPrompt,
    ollama,
    new StringOutputParser(),
  ]);

  const formattedDocs = await retrievalChain.invoke({
    question: text,
    chat_history: chatHistory.map((message) => `${message.role}: ${message.content}`).join('\n'),
  });

  const stream = await responseChain.stream({
    question: text,
    chat_history: chatHistory.map((chatMessage) => {
      if (chatMessage.role === "human") {
        return new HumanMessage(chatMessage.content);
      } else {
        return new AIMessage(chatMessage.content);
      }
    }),
    context: formattedDocs,
  });

  for await (const chunk of stream) {
    if (chunk) {
      self.postMessage({
        type: "chunk",
        data: chunk,
      });
    }
  }

  self.postMessage({
    type: "complete",
    data: "OK",
  });
}

// Listen for messages from the main thread
self.addEventListener("message", async (event: any) => {
  self.postMessage({
    type: "log",
    data: `Received: ${JSON.stringify(event.data)}`,
  });

  if (event.data.pdf) {
    await embedPDF(event.data.pdf);
  } else {
    await queryVectorStore(event.data.messages);
  }

  self.postMessage({
    type: "complete",
    data: "OK",
  });
});