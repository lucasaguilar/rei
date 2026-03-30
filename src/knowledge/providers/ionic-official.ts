import { BaseOfficialProvider } from "./base-official-provider.js";

export class IonicOfficialProvider extends BaseOfficialProvider {
  name = "Ionic Framework Official";
  
  protected triggerKeywords = [
    "ionic",
    "capacitor",
    "ion-",
    "tabs",
    "cordova"
  ];

  protected allowedDomains = ["ionicframework.com"];
}
