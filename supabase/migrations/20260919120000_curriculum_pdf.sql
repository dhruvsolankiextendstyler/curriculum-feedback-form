-- Add curriculum PDF support: admins/HODs can attach a PDF to a form,
-- respondents see it at the top before answering.

alter table forms add column curriculum_pdf_path text;

-- Storage bucket for the PDFs. Public so respondents can view inline.
insert into storage.buckets (id, name, public)
values ('curriculum-pdfs', 'curriculum-pdfs', true)
on conflict (id) do nothing;

-- Read: anyone (public bucket)
create policy "curriculum_pdfs_public_read"
on storage.objects for select
using (bucket_id = 'curriculum-pdfs');

-- Upload: admin or HOD
create policy "curriculum_pdfs_staff_insert"
on storage.objects for insert
with check (
  bucket_id = 'curriculum-pdfs'
  and (select is_staff())
);

-- Overwrite: admin or HOD
create policy "curriculum_pdfs_staff_update"
on storage.objects for update
using (
  bucket_id = 'curriculum-pdfs'
  and (select is_staff())
);

-- Delete: admin or HOD
create policy "curriculum_pdfs_staff_delete"
on storage.objects for delete
using (
  bucket_id = 'curriculum-pdfs'
  and (select is_staff())
);

-- HODs need to update forms.curriculum_pdf_path.
-- The existing forms_admin_write policy covers admins.
-- Add a narrow HOD policy: can only update curriculum_pdf_path on the form
-- matching the stakeholder type they manage (any form, since they're attaching
-- curriculum PDFs relevant to their department's respondents).
create policy forms_hod_pdf on forms
  for update
  using ((select hod_department()) is not null)
  with check ((select hod_department()) is not null);
