import { registerOllamaHandlers } from "./local_model_ollama_handler";
import { registerLMStudioHandlers } from "./local_model_lmstudio_handler";
import { registerGeniusCoreLocalModelsHandlers } from "./local_model_genius_core_handler";
import log from "electron-log";

const logger = log.scope("local_models");

export function registerLocalModelHandlers() {
  logger.info("Registering local model handlers...");
  registerOllamaHandlers();
  registerLMStudioHandlers();
  registerGeniusCoreLocalModelsHandlers();
  logger.info("Local model handlers registered");
}
