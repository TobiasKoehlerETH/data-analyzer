import { Toaster as Sonner, type ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => (
  <Sonner
    theme="light"
    className="toaster group"
    toastOptions={{
      style: { borderRadius: 0, fontFamily: "var(--ap-font)", boxShadow: "var(--ap-box-shadow)" },
    }}
    {...props}
  />
);

export { Toaster };
