import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { addVat } from "../vat";

interface Props {
  /** The typed price awaiting confirmation, or null when closed. */
  typed: string | null;
  /** exclusive=true: the typed price excludes VAT (14% is added). */
  onAnswer: (exclusive: boolean) => void;
}

/** Confirms whether a manually typed price on a tax-marked line excludes VAT. */
export function VatPriceConfirm({ typed, onAnswer }: Props) {
  return (
    <AlertDialog
      open={typed !== null}
      onOpenChange={(open) => {
        // Closing without a choice keeps the typed price as it is.
        if (!open) onAnswer(false);
      }}
    >
      <AlertDialogContent dir="rtl">
        <AlertDialogHeader>
          <AlertDialogTitle>تأكيد السعر</AlertDialogTitle>
          <AlertDialogDescription>
            السعر الذي أدخلته {typed} — هل هو غير شامل الضريبة؟
            {typed !== null && (
              <>
                {" "}
                إذا كان كذلك سيصبح <strong>{addVat(typed)}</strong> بعد إضافة 14%.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => onAnswer(false)}>
            لا، السعر شامل الضريبة كما هو
          </AlertDialogCancel>
          <AlertDialogAction onClick={() => onAnswer(true)}>نعم، أضف 14%</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
