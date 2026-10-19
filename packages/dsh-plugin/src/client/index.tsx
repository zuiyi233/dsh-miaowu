import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";

// 拆分后的插件入口壳:注册(apply/name/inject)在 workbench-seat,
// 工作台主体按模块拆分(creative-workbench 等),此处只做 re-export。
// isGameAudio 保留供 tests/game-audio.test.ts 从 index 导入。
import { name, inject, apply } from "./workbench-seat.js";
import { isGameAudio } from "./game-studio.js";

export { name, inject, apply, isGameAudio };

const plugin = { name, inject, apply };

export default plugin;
