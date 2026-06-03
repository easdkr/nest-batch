// Try to actually load the entity and see what fails
import('reflect-metadata').then(reflect => {
  console.log('reflect-metadata loaded');
  return import('./src/entities/job-meta.entities.ts');
}).then(m => {
  console.log('entities loaded');
  console.log('JobInstanceEntity:', typeof m.JobInstanceEntity);
}).catch(e => {
  console.error('Error:', e.message);
  console.error('Stack:', e.stack);
});
