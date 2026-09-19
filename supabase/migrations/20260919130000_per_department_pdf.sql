-- Move curriculum PDFs from a single column on forms to a per-department table.
-- department_id = null means college-wide (shown to all respondents of that form).

create table curriculum_pdfs (
  id            uuid primary key default gen_random_uuid(),
  form_id       uuid not null references forms (id) on delete cascade,
  department_id uuid references departments (id) on delete cascade,
  pdf_path      text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index curriculum_pdfs_unique
  on curriculum_pdfs (form_id, coalesce(department_id, '00000000-0000-0000-0000-000000000000'));

alter table curriculum_pdfs enable row level security;

-- Migrate existing data
insert into curriculum_pdfs (form_id, department_id, pdf_path)
select id, null, curriculum_pdf_path
from forms
where curriculum_pdf_path is not null;

-- Drop the old column
alter table forms drop column curriculum_pdf_path;

-- Drop the HOD policy that was only for the old column
drop policy if exists forms_hod_pdf on forms;

-- Read: any authenticated user
create policy curriculum_pdfs_read on curriculum_pdfs
  for select using (auth.uid() is not null);

-- Insert/update/delete: staff (admin or HOD)
create policy curriculum_pdfs_staff_write on curriculum_pdfs
  for all using ((select is_staff())) with check ((select is_staff()));
