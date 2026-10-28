/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 高德 Web 端(JS API) key。留空 = HUD 用程序化底图 */
  readonly VITE_AMAP_JS_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
