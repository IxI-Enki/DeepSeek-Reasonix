import { useEffect, useState } from "react";
import { t } from "../i18n";
import { reason } from "../i18n/kernel";
import type { AgentPort, PeersSettings } from "../port/port";
import { Switch } from "./Switch";

export function PeersSwitch({ port }: { port: AgentPort }) {
  const [state, setState] = useState<PeersSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    port
      .peersSettings()
      .then(setState)
      .catch(() => setState(null));
  }, [port]);

  if (!state) return <div className="empty">{t("无法读取会话间消息的设置。")}</div>;

  const flip = async () => {
    setBusy(true);
    setError("");
    try {
      setState(await port.savePeersSettings(!state.enabled));
    } catch (e) {
      setError(reason(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="box">
      <div className="lrow">
        <span className="tx">
          <span className="lb">{t("会话间消息")}</span>
          <span className="ds">{t("开启后，模型能看到 list_peers 和 send_peer_message，给本机的其他会话发文字；对方发来的消息要你批准才会交给模型，批准入口在输入框上方。关闭时本会话不对外发布，也不读信箱。只对之后新开的会话生效，已开的会话要重新打开。")}</span>
        </span>
        <Switch
          data-action="peers.enabled"
          on={state.enabled}
          busy={busy}
          label={t("会话间消息")}
          onClick={() => void flip()}
        />
      </div>
      {error && <div className="why">{error}</div>}
    </div>
  );
}
