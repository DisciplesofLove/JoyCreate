/**
 * JoySearch IPC Client — renderer-side API for the joy-search:* channels.
 */

import type {
  JoySearchAnswerRequest,
  JoySearchAnswerResponse,
  JoySearchFetchPageRequest,
  JoySearchFetchPageResponse,
  JoySearchLensRequest,
  JoySearchLensResponse,
  JoySearchQueryRequest,
  JoySearchQueryResponse,
  JoySearchSuggestRequest,
  JoySearchSuggestResponse,
} from "../../types/joy_search";

export class JoySearchClient {
  private static instance: JoySearchClient;

  static getInstance(): JoySearchClient {
    if (!JoySearchClient.instance) {
      JoySearchClient.instance = new JoySearchClient();
    }
    return JoySearchClient.instance;
  }

  private invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    return window.electron.ipcRenderer.invoke(channel, ...args) as Promise<T>;
  }

  query(req: JoySearchQueryRequest): Promise<JoySearchQueryResponse> {
    return this.invoke("joy-search:query", req);
  }

  fetchPage(req: JoySearchFetchPageRequest): Promise<JoySearchFetchPageResponse> {
    return this.invoke("joy-search:fetch-page", req);
  }

  lens(req: JoySearchLensRequest): Promise<JoySearchLensResponse> {
    return this.invoke("joy-search:lens", req);
  }

  answer(req: JoySearchAnswerRequest): Promise<JoySearchAnswerResponse> {
    return this.invoke("joy-search:answer", req);
  }

  suggest(req: JoySearchSuggestRequest): Promise<JoySearchSuggestResponse> {
    return this.invoke("joy-search:suggest", req);
  }
}

export const joySearchClient = JoySearchClient.getInstance();
