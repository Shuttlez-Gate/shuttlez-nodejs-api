export type InstaPayInstructions = {
  provider: 'manual_instapay';
  accountName: string;
  ipa: string;
  phone: string;
  bankName: string;
  instructions: string;
  configured: boolean;
};

export interface PackagePaymentProvider {
  readonly code: 'manual_instapay';
  instructions(): InstaPayInstructions;
}

const DEFAULT_INSTRUCTIONS =
  'حوّل المبلغ على رقم إنستاباي، ارفع صورة التحويل، ثم انتظر مراجعة الإدارة.';

export const RIDER_INSTAPAY_PHONE = '01024139097';

export class ManualInstaPayProvider implements PackagePaymentProvider {
  readonly code = 'manual_instapay' as const;

  instructions(): InstaPayInstructions {
    const accountName = process.env.INSTAPAY_ACCOUNT_NAME?.trim() || '';
    const ipa = process.env.INSTAPAY_IPA?.trim() || RIDER_INSTAPAY_PHONE;
    const bankName = process.env.INSTAPAY_BANK_NAME?.trim() || 'InstaPay';
    const instructions = process.env.INSTAPAY_INSTRUCTIONS?.trim() || DEFAULT_INSTRUCTIONS;
    return {
      provider: this.code,
      accountName,
      ipa,
      phone: RIDER_INSTAPAY_PHONE,
      bankName,
      instructions,
      configured: true,
    };
  }
}

export function packagePaymentProvider(): PackagePaymentProvider {
  return new ManualInstaPayProvider();
}
