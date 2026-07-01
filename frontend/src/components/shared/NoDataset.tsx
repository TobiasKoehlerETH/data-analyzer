import { Link } from "react-router-dom"
import { Upload } from "lucide-react"

import { IconButton } from "@/components/shared/IconButton"
import { Card, CardContent } from "@/components/ui/card"

export function NoDataset() {
  return (
    <Card className="mx-auto mt-16 max-w-md text-center">
      <CardContent className="py-10">
        <p className="mb-4 text-sm text-muted-foreground">No dataset</p>
        <IconButton label="Load data" asChild>
          <Link to="/load"><Upload /></Link>
        </IconButton>
      </CardContent>
    </Card>
  )
}
