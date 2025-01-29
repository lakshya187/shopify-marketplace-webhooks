import { handler } from "../index.js";
import {
  CREATE_PRODUCT,
  ORDER_CREATE_PAYLOAD,
  ORDER_FULFILLED,
  PRODUCT_UPDATE,
} from "./testPayloads.js";

(async () => {
  try {
    const result = await handler(ORDER_CREATE_PAYLOAD);
    console.log("Lambda Response:", result);
  } catch (error) {
    console.error("Error testing Lambda:", error);
  }
})();
