import { describe, expect, it } from "vitest";
import { SPELLS } from "@/rules-engine";
import { parseEquipmentColumn, parseSpellTable } from "./parseTables";

describe("parseEquipmentColumn", () => {
  it("defaults quantity to 1 when OCR drops a bare '1'", () => {
    // matches the real OCR behavior observed on the sample PDF: most-common
    // qty-1 rows lose their quantity token entirely under SPARSE_TEXT.
    const ocrText = ["Leather", "10 Ib.", "Dagger", "1 Ib.", "Shortbow", "2 Ib."].join("\n");
    expect(parseEquipmentColumn(ocrText)).toEqual([
      { name: "Leather", quantity: 1 },
      { name: "Dagger", quantity: 1 },
      { name: "Shortbow", quantity: 1 },
    ]);
  });

  it("picks up an explicit quantity when OCR does find one", () => {
    const ocrText = ["Arrows", "20", "1 Ib.", "Oil", "7", "7 Ib.", "Ball Bearings", "1,000", "2 Ib."].join("\n");
    expect(parseEquipmentColumn(ocrText)).toEqual([
      { name: "Arrows", quantity: 20 },
      { name: "Oil", quantity: 7 },
      { name: "Ball Bearings", quantity: 1000 },
    ]);
  });

  it("ignores table headers, currency rows, and the footer line", () => {
    const ocrText = ["EQUIPMENT", "NAME", "QTY", "WEIGHT", "CP", "Rope", "1 Ib.", "TM & © 2018 Wizards"].join("\n");
    expect(parseEquipmentColumn(ocrText)).toEqual([{ name: "Rope", quantity: 1 }]);
  });

  it("returns an empty list for a blank table", () => {
    expect(parseEquipmentColumn("")).toEqual([]);
  });
});

describe("parseSpellTable", () => {
  const spellNames = SPELLS.map((s) => s.name);

  it("matches known spell names out of noisy OCR text", () => {
    const firstSpell = SPELLS[0].name;
    const ocrText = ["PREP SPELL NAME LEVEL", `O ${firstSpell}`, "=== NOTES ==="].join("\n");
    expect(parseSpellTable(ocrText, spellNames)).toContain(firstSpell);
  });

  it("returns nothing for an empty spellcasting page (non-caster)", () => {
    const ocrText = ["PREP SPELL NAME SAVE/ATK TIME RANGE COMP DURATION"].join("\n");
    expect(parseSpellTable(ocrText, spellNames)).toEqual([]);
  });

  it("doesn't hallucinate a spell from unrelated text", () => {
    expect(parseSpellTable("Breath Weapon Lightning 2 Long Rest", spellNames)).toEqual([]);
  });
});
