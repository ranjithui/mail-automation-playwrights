import { Link } from 'react-router-dom';
import { FileQuestion } from 'lucide-react';
import { Button } from '@/components/ui/primitives';
import { EmptyState } from '@/components/ui/data';

export function NotFoundPage() {
  return (
    <div className="p-6">
      <EmptyState
        icon={FileQuestion}
        title="Page not found"
        description="That screen does not exist, or it moved. Head back to the dashboard and try from there."
        action={
          <Button variant="primary" asChild>
            <Link to="/">Back to dashboard</Link>
          </Button>
        }
      />
    </div>
  );
}
