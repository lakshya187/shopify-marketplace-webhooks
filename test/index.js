import { handler } from "../index.js";
import {
  CREATE_PRODUCT,
  ORDER_CREATE_PAYLOAD,
  ORDER_FULFILLED,
  PRODUCT_UPDATE,
  APP_UNINSTALL,
  ORDER_PAID,
} from "./testPayloads.js";

(async () => {
  try {
    const result = await handler(ORDER_PAID);
    console.log("Lambda Response:", result);
  } catch (error) {
    console.error("Error testing Lambda:", error);
  }
})();
