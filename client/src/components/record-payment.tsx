import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Banknote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { apiRequest } from "@/lib/queryClient";
import { money } from "@/lib/format";

const METHODS = [
  { value: "cash", label: "Tiền mặt" },
  { value: "card_on_file", label: "Thẻ (POS)" },
  { value: "bank_transfer", label: "Chuyển khoản" },
  { value: "payment_link", label: "Link thanh toán" },
] as const;

/**
 * Record money the desk has already taken.
 *
 * The system could create a payment intent but nothing could ever settle one:
 * `confirmPayment` was reachable only by an API call with no button anywhere, so
 * the `payments` table stayed empty while real cash crossed the desk and folios
 * showed a balance that had in fact been paid.
 *
 * This does NOT take a payment — Aurea holds no card data and talks to no
 * gateway. The guest pays on the hotel's own terminal; this writes it down, and
 * the folio gets its negative payment line.
 */
export function RecordPayment({
  reservationId,
  confirmationCode,
  balanceDue,
}: {
  reservationId: number;
  confirmationCode: string;
  balanceDue: number;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  /* Pre-filled with what is outstanding, because that is what is being paid
     nine times out of ten — but editable, since part-payments are normal. */
  const [amount, setAmount] = useState(String(Math.max(0, Math.round(balanceDue))));
  const [method, setMethod] = useState<string>("cash");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: async () =>
      apiRequest("POST", `/api/reservations/${reservationId}/payment`, {
        amount: Number(amount),
        method,
        reference: reference.trim(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/reservations"] });
      qc.invalidateQueries({ queryKey: ["/api/insights"] });
      setOpen(false);
      setReference("");
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  const amountNum = Number(amount);
  const valid = Number.isFinite(amountNum) && amountNum > 0 && reference.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-[11px]"
          data-testid={`record-payment-${confirmationCode}`}
        >
          <Banknote className="mr-1 h-3 w-3" />
          Ghi nhận thu
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ghi nhận đã thu tiền</DialogTitle>
          <DialogDescription>
            Đặt phòng {confirmationCode} · còn phải trả {money(balanceDue)}.
            <br />
            Chỉ ghi lại khoản đã thu ở quầy — hệ thống không thực hiện thanh toán.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label className="block text-xs font-medium">
            Số tiền
            <Input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1"
              data-testid="payment-amount"
            />
          </label>

          <div className="text-xs font-medium">
            Hình thức
            <div className="mt-1 flex flex-wrap gap-1.5">
              {METHODS.map((m) => (
                <Button
                  key={m.value}
                  type="button"
                  variant={method === m.value ? "default" : "outline"}
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setMethod(m.value)}
                >
                  {m.label}
                </Button>
              ))}
            </div>
          </div>

          <label className="block text-xs font-medium">
            Mã tham chiếu
            {/* Required, not optional: a payment line with no reference cannot be
                reconciled against the terminal's own report at end of shift. */}
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Số biên lai / mã giao dịch POS"
              className="mt-1"
              data-testid="payment-reference"
            />
          </label>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Huỷ
          </Button>
          <Button
            size="sm"
            disabled={!valid || submit.isPending}
            onClick={() => submit.mutate()}
            data-testid="payment-submit"
          >
            {submit.isPending ? "Đang ghi..." : "Ghi nhận"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
