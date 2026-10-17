import { describe, it, expect } from "vitest";
import { extractLearnableTerms, pickLearnableKeywords } from "../../modules/rfq/classification";

// Regression: a manager's correction taught «genral» (from the ERP line-item
// label 5730.021.GENRAL.0702) and «diameter» (a size word) as category rules,
// which then misclassified ~900 items as الميكانيكا. Neither may ever be learned.
describe("learnable keywords — no line-item labels, no generic size words", () => {
  it("never learns words from the line item label", () => {
    const terms = extractLearnableTerms({
      description: "SOLDER,SLIVER,RODS",
      partNo: null,
      lineItem: "5730.021.GENRAL.0702",
    });
    expect(terms).not.toContain("genral");
    expect(terms).not.toContain("general");
  });

  it("never learns generic dimension words", () => {
    const terms = extractLearnableTerms({
      description: "P/N : 440F , SILVER SOLDER FLUXED ROD DIAMETER 1.5MM X 500MM (5 ROD PACK)",
      partNo: "440F",
      lineItem: "5730.021.GENRAL.0702",
    });
    expect(terms).not.toContain("diameter");
    expect(terms).not.toContain("genral");
    expect(terms).not.toContain("pack");
  });

  it("still learns the product words from the description", () => {
    const terms = pickLearnableKeywords({
      description: "FLUX,SOLDER SLIVER 8OZ",
      partNo: null,
      lineItem: "5740.017.GENRAL.0002",
    });
    expect(terms).toContain("solder");
    expect(terms).toContain("flux");
    expect(terms).not.toContain("genral");
  });
});
