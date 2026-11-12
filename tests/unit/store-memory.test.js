import { runContract } from "./store.contract.js";
import { createMemoryStore } from "../helpers/store-memory.js";

runContract("memory", async () => createMemoryStore());
