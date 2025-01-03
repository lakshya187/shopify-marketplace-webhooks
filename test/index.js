import { handler } from "../index.js";
import { ORDER_CREATE_PAYLOAD } from "./testPayloads.js";

(async () => {
  try {
    const result = await handler(ORDER_CREATE_PAYLOAD);
    console.log("Lambda Response:", result);
  } catch (error) {
    console.error("Error testing Lambda:", error);
  }
})();
