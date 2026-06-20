import { Form, LabelRow, Section, ToggleRow, type FormSectionElement } from "@paperback/types";

import { defaultPolicyForContentType } from "../policy.js";
import type { TrackingPolicy } from "../models.js";

export class TrackingForm extends Form {
  private readonly policy: TrackingPolicy;

  constructor(private readonly malMangaId: string) {
    super();
    this.policy =
      (Application.getState(`malPolicy:${malMangaId}`) as TrackingPolicy | undefined) ??
      defaultPolicyForContentType("manga");
  }

  override getSections(): FormSectionElement<unknown>[] {
    return [
      Section({ id: "tracking", header: "Tracking" }, [
        LabelRow("mode", { title: "Mode", subtitle: this.policy.mode }),
        ToggleRow("ignore-specials", {
          title: "Ignore Specials",
          value: this.policy.ignoreSpecials,
          onValueChange: Application.Selector(this as TrackingForm, "handleIgnoreSpecials"),
        }),
        ToggleRow("completion", {
          title: "Auto Complete Known Totals",
          value: this.policy.markCompletedAutomatically,
          onValueChange: Application.Selector(this as TrackingForm, "handleAutoComplete"),
        }),
      ]),
    ];
  }

  async handleIgnoreSpecials(value: boolean): Promise<void> {
    this.save({ ...this.policy, ignoreSpecials: value });
  }

  async handleAutoComplete(value: boolean): Promise<void> {
    this.save({ ...this.policy, markCompletedAutomatically: value });
  }

  private save(policy: TrackingPolicy): void {
    Application.setState(policy, `malPolicy:${this.malMangaId}`);
  }
}
