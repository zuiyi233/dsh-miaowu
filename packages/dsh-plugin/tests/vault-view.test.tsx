import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VaultView, type VaultViewProps } from "../src/client/features/vault-feature.js";

const BASE: VaultViewProps = {
  status: { enabled: true, ready: true },
  disabled: false,
  names: ["alpha", "zeta"],
  name: "",
  value: "",
  revealed: undefined,
  busy: false,
  notice: undefined,
  error: undefined,
  onRefresh: () => undefined,
  onNameChange: () => undefined,
  onValueChange: () => undefined,
  onSave: () => undefined,
  onReveal: () => undefined,
  onHide: () => undefined,
  onDelete: () => undefined,
  onRotate: () => undefined,
  onCopy: () => undefined,
};

function render(overrides: Partial<VaultViewProps> = {}): string {
  return renderToStaticMarkup(<VaultView {...BASE} {...overrides} />);
}

describe("VaultView", () => {
  it("未启用时只显示开关说明，不渲染写入与条目操作", () => {
    const html = render({ disabled: true, status: undefined, names: [] });
    expect(html).toContain("凭据保险库");
    expect(html).toContain("未启用");
    expect(html).toContain("DSH_MIAOWU_VAULT_ENABLED=1");
    expect(html).not.toContain("写入 / 更新");
    expect(html).not.toContain("轮换主密钥");
  });

  it("启用后渲染名称列表与操作，默认不暴露任何明文", () => {
    const html = render();
    expect(html).toContain("已就绪");
    expect(html).toContain("alpha");
    expect(html).toContain("zeta");
    expect(html).toContain("读取");
    expect(html).toContain("删除");
    expect(html).toContain("轮换主密钥");
    expect(html).not.toContain("oh-vault-revealed");
  });

  it("显式读取后才渲染单条明文与隐藏/复制操作", () => {
    const html = render({ revealed: { name: "alpha", value: "sk-live-token" } });
    expect(html).toContain("sk-live-token");
    expect(html).toContain("隐藏");
    expect(html).toContain("复制");
  });

  it("错误与提示都可见，未初始化时禁止轮换", () => {
    const html = render({
      status: { enabled: true, ready: false },
      error: "读取失败。",
      notice: "已写入 alpha。",
    });
    expect(html).toContain("读取失败。");
    expect(html).toContain("已写入 alpha。");
    expect(html).toContain("未初始化");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>轮换主密钥<\/button>/u);
  });
});
