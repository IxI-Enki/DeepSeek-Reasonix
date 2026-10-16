import { t } from "../i18n";
import type { AgentPort } from "../port/port";
import { Group } from "./Group";
import { PeersSwitch } from "./PeersSwitch";
import { SubagentClaims } from "./SubagentClaims";
import { WriteLease } from "./WriteLease";

export function SessionCoordination({ port, onChanged }: { port: AgentPort; onChanged: () => void }) {
  return (
    <>
      <Group id="write-lease"
        title={t("多个会话同时写一个项目")}
        hint={t("多个会话在同一个项目里工作时如何互相等待。默认严格：没声明写入范围的操作（bash、MCP、没写 write_paths 的子代理）会占住整个工作区，其他会话要等它结束。只影响之后新开的会话，已在运行的会话保持它启动时的设置。")}
      >
        <WriteLease port={port} />
      </Group>
      <Group id="peers"
        title={t("会话间消息（实验）")}
        hint={t("同一台机器上的会话互相发文字，由模型发送。收到的文字先挂起，只有你批准才会交给模型；发出去的文字也要对方的用户批准。默认关闭。")}
      >
        <PeersSwitch port={port} />
      </Group>
      <Group id="subagent-claims"
        title={t("子代理的写入范围")}
        hint={t("后台子代理写文件时如何占用工作区。默认严格：没有声明 write_paths 的子代理占住整个工作区，其他写入要等它结束。修改会重建运行时，任务运行期间无法变更。")}
      >
        <SubagentClaims port={port} onChanged={onChanged} />
      </Group>
    </>
  );
}
