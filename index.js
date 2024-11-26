import logger from "#common-functions/logger/index.js";
import OrderCreateEventHandler from "#controllers/orders/create.js";

const EVENT_CONTROLLER_MAPPER = {
  "orders/create": OrderCreateEventHandler,
};

export const handler = async (event) => {
  logger("info", `Event: ${JSON.stringify(event)}`);

  const { detail: record } = event;

  const { metadata, payload } = record;

  const storeUrl = metadata["X-Shopify-Shop-Domain"];
  const webhookTopic = metadata["X-Shopify-Topic"];

  logger("info", `Store URL: ${storeUrl}`);
  logger("info", `Webhook Topic: ${webhookTopic}`);

  if (!EVENT_CONTROLLER_MAPPER[webhookTopic]) {
    logger("error", `No controller found for topic: ${webhookTopic}`);
    return;
  }
  const eventHandler = EVENT_CONTROLLER_MAPPER[webhookTopic];
  await eventHandler(payload, metadata);

  const response = {
    statusCode: 200,
    body: JSON.stringify("Processed successfully"),
  };
  return response;
};
