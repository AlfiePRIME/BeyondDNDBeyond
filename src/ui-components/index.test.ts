import { describe, expect, it } from "vitest";
import {
  Badge,
  Button,
  CHAT_COLOR_CODES,
  ChatText,
  ChoiceCard,
  Glitch,
  Modal,
  MODULE_NAME,
  Panel,
  parseChatFormatting,
  SectionHeader,
  Select,
  TextInput,
  VHS,
} from "@/ui-components";

describe("ui-components module", () => {
  it("is independently importable and testable", () => {
    expect(MODULE_NAME).toBe("ui-components");
  });

  it("exports the shared component library from the barrel", () => {
    for (const component of [Button, Panel, TextInput, Select, Modal, Badge, SectionHeader, ChoiceCard, ChatText]) {
      expect(component).toBeTypeOf("function");
    }
  });

  it("exports the CanvasUI effects", () => {
    expect(Glitch).toBeTypeOf("function");
    expect(VHS).toBeTypeOf("function");
  });

  it("exports the chat formatting parser and its color table", () => {
    expect(parseChatFormatting).toBeTypeOf("function");
    expect(CHAT_COLOR_CODES["4"]).toBeTypeOf("string");
  });
});
