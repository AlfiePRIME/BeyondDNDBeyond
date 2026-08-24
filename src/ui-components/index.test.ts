import { describe, expect, it } from "vitest";
import {
  Badge,
  Button,
  Glitch,
  Modal,
  MODULE_NAME,
  Panel,
  SectionHeader,
  TextInput,
  VHS,
} from "@/ui-components";

describe("ui-components module", () => {
  it("is independently importable and testable", () => {
    expect(MODULE_NAME).toBe("ui-components");
  });

  it("exports the shared component library from the barrel", () => {
    for (const component of [Button, Panel, TextInput, Modal, Badge, SectionHeader]) {
      expect(component).toBeTypeOf("function");
    }
  });

  it("exports the CanvasUI effects", () => {
    expect(Glitch).toBeTypeOf("function");
    expect(VHS).toBeTypeOf("function");
  });
});
