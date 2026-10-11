import { t } from "../../i18n";
import { elapsed } from "../../i18n/format";

export function WorkedLine({ ms }: { ms: number }) {
  return (
    <div className="rc">
      <div className="rc-ok">
        <span className="rc-t">{t("耗时 {t}", { t: elapsed(ms) })}</span>
      </div>
    </div>
  );
}
