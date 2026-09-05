const GAME_ART_IMAGE_PATTERN = /\.(?:png|jpe?g|webp|gif)$/iu;

/**
 * 游戏美术分组规则:当前项目 art/ 下递归 + 项目根直属图片。
 * oh_story_comfyui 产物落在 game-adaptations/<项目>/art/。
 */
export function isGameArtImage(path: string, root: string): boolean {
  if (!GAME_ART_IMAGE_PATTERN.test(path)) return false;
  if (path.startsWith(`${root}/art/`)) return true;
  const rest = path.slice(root.length + 1);
  return rest !== "" && !rest.includes("/");
}
