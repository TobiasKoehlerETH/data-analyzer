import { Link } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

export function NoDataset() {
  return (
    <Card className="mx-auto mt-16 max-w-md text-center">
      <CardContent className="py-10">
        <p className="mb-4 text-sm text-muted-foreground">Load a dataset first.</p>
        <Button asChild>
          <Link to="/load">Load a CSV</Link>
        </Button>
      </CardContent>
    </Card>
  )
}
