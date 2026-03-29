import { BaseOfficialProvider } from "./base-official-provider.js";

export class SpringOfficialProvider extends BaseOfficialProvider {
  name = "Spring / Spring Boot Official";

  protected triggerKeywords = [
    "spring",
    "spring boot",
    "restcontroller",
    "jparepository",
    "autowired",
    "applicationcontext",
    "bean",
    "component"
  ];

  protected allowedDomains = ["spring.io"];
}
