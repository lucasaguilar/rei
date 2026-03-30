import { BaseOfficialProvider } from "./base-official-provider.js";

export class AngularOfficialProvider extends BaseOfficialProvider {
  name = "Angular / NgRx Official";
  
  protected triggerKeywords = [
    "angular",
    "angular material",
    "mat-",
    "ngrx",
    "signal store",
    "signalstore",
    "signals",
    "standalone component",
    "rxjs",
    "zoneless",
    "componentstore",
    "inject"
  ];

  protected allowedDomains = ["angular.dev", "ngrx.io", "rxjs.dev", "material.angular.dev"];
}
