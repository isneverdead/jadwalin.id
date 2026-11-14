import { SavedBookings } from "@/components/saved-bookings";

export const metadata = { title: "Booking saya · jadwalin.id" };

export default function MyBookingsPage() {
  return (
    <>
      <h1>Booking saya</h1>
      <p>Daftar ini disimpan di perangkat dan browser ini saja, tidak dikirim ke server. Menghapus data browser akan menghapusnya.</p>
      <SavedBookings />
    </>
  );
}
