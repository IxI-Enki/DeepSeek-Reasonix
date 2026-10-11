// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import "../testkit";
import { WorkedLine } from "./WorkedLine";
import { t } from "../../i18n";

afterEach(cleanup);

describe("the worked line", () => {
  it("says how long the turn ran, in the compact form", () => {
    const box = render(<WorkedLine ms={65_000} />).container;
    expect(box.querySelector(".rc-t")?.textContent).toBe(t("耗时 {t}", { t: "1m 5s" }));
    expect(box.textContent).toContain("1m 5s");
  });
});
