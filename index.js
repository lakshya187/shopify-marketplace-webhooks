import logger from "#common-functions/logger/index.js";
import OrderCreateEventHandler from "#controllers/orders/create.js";

const EVENT_CONTROLLER_MAPPER = {
  "orders/create": OrderCreateEventHandler,
};

export const handler = async (event) => {
  logger("info", `Event: ${JSON.stringify(event)}`);

  // Loop through message records

  // eslint-disable-next-line no-restricted-syntax
  for (const record of event.Records) {
    const body = JSON.parse(record.body);

    logger("info", `Body: ${JSON.stringify(body)}`);

    const {
      detail: { metadata, payload },
    } = body;

    const storeUrl = metadata["X-Shopify-Shop-Domain"];
    const webhookTopic = metadata["X-Shopify-Topic"];

    logger("info", `Store URL: ${storeUrl}`);
    logger("info", `Webhook Topic: ${webhookTopic}`);

    if (!EVENT_CONTROLLER_MAPPER[webhookTopic]) {
      logger("error", `No controller found for topic: ${webhookTopic}`);
      // eslint-disable-next-line no-continue
      continue;
    }

    const eventHandler = EVENT_CONTROLLER_MAPPER[webhookTopic];

    // eslint-disable-next-line no-await-in-loop
    await eventHandler(payload, metadata);
  }

  const response = {
    statusCode: 200,
    body: JSON.stringify("Processed successfully"),
  };
  return response;
};
