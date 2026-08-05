/**
 * Smartlead campaign AI categorization + bounce auto-protection settings.
 *
 * These live on POST /campaigns/{id}/settings (confirmed via api.smartlead.ai docs
 * and live probing). GET /campaigns/{id} does NOT echo them back.
 *
 * Field names (British spelling "categorisation" is required by the API):
 * - bounce_autopause_threshold: string percent, e.g. "7". null clears/disables.
 * - ai_categorisation_options: array of lead category IDs (numbers)
 * - out_of_office_detection_settings:
 *   - ignoreOOOasReply
 *   - autoReactivateOOO (delay-based restart; mutually exclusive with autoCategorizeOOO)
 *   - reactivateOOOwithDelay (days, or null)
 *   - autoCategorizeOOO (AI parse return date + restart)
 */

export type OutOfOfficeDetectionSettings = {
  ignoreOOOasReply: boolean;
  autoReactivateOOO: boolean;
  reactivateOOOwithDelay: number | null;
  autoCategorizeOOO: boolean;
};

export type AiBounceSettings = {
  bounce_autopause_threshold?: string | null;
  ai_categorisation_options?: number[];
  out_of_office_detection_settings?: OutOfOfficeDetectionSettings;
};

/** Default category IDs from GET /leads/fetch-categories (account defaults). */
export const DEFAULT_AI_CATEGORY_IDS = {
  interested: 1,
  not_interested: 3,
  out_of_office: 6,
} as const;

/**
 * BCP campaign defaults matching the Smartlead UI:
 * - AI categories: Out of Office, Interested, Not Interested
 * - Auto-restart AI-categorised OOO when lead returns: ON (autoCategorizeOOO)
 * - Ignore OOO from reply %: OFF
 * - Re-activate OOO after delay (deprecated): OFF
 * - Bounce auto-protection: ON at 7%
 */
export const BCP_AI_BOUNCE_DEFAULTS: Required<AiBounceSettings> = {
  bounce_autopause_threshold: "7",
  ai_categorisation_options: [
    DEFAULT_AI_CATEGORY_IDS.out_of_office,
    DEFAULT_AI_CATEGORY_IDS.interested,
    DEFAULT_AI_CATEGORY_IDS.not_interested,
  ],
  out_of_office_detection_settings: {
    ignoreOOOasReply: false,
    autoReactivateOOO: false,
    reactivateOOOwithDelay: null,
    autoCategorizeOOO: true,
  },
};

export function buildAiBounceSettingsPayload(
  settings: AiBounceSettings
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if ("bounce_autopause_threshold" in settings) {
    body.bounce_autopause_threshold = settings.bounce_autopause_threshold;
  }

  if (settings.ai_categorisation_options !== undefined) {
    body.ai_categorisation_options = settings.ai_categorisation_options;
  }

  if (settings.out_of_office_detection_settings !== undefined) {
    const ooo = settings.out_of_office_detection_settings;
    if (ooo.autoCategorizeOOO && ooo.autoReactivateOOO) {
      throw new Error(
        "autoCategorizeOOO and autoReactivateOOO are mutually exclusive on Smartlead — enable only one OOO restart strategy."
      );
    }
    body.out_of_office_detection_settings = {
      ignoreOOOasReply: ooo.ignoreOOOasReply,
      autoReactivateOOO: ooo.autoReactivateOOO,
      reactivateOOOwithDelay: ooo.reactivateOOOwithDelay,
      autoCategorizeOOO: ooo.autoCategorizeOOO,
    };
  }

  if (Object.keys(body).length === 0) {
    throw new Error(
      "Provide at least one of: bounce_autopause_threshold, ai_categorisation_options, out_of_office_detection_settings"
    );
  }

  return body;
}
