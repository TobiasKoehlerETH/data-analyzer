import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

/** Temporary stand-in for screens not yet implemented. */
export function Placeholder({ title, note }: { title: string; note?: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        {note ?? "This screen is under construction."}
      </CardContent>
    </Card>
  )
}
