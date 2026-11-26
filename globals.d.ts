export {};

declare global {
  interface Window {
    SIM_STATE_CORE: any;
    SIM_API_FACTORY: any;
    SIM_HEADLESS: any;
    CATALOG: any;
    QUEUE_ENGINE: any;
    SCENARIO: any;
  }

  var PRICING: any;
}
