/**
 * 主机侧加载器入口：本插件没有任何主机侧行为，全部逻辑在浏览器端
 * （`dsh.client` 声明的 `./client` bundle 里）。这个空 apply 让加载器
 * 能够把本包挂载为 web 组合里的一个条目。
 */
export function apply() {}
