-- 26/11/2026: bajas de Eneko Ruiz y Mario; Shazia (smaryam) pasa a visitante
delete from public.miembros_permitidos where email in ('eneko.ruizd@alumni.mondragon.edu','mario.espinosa@alumni.mondragon.edu');
delete from public.perfiles where email in ('eneko.ruizd@alumni.mondragon.edu','mario.espinosa@alumni.mondragon.edu');
delete from auth.users where email in ('eneko.ruizd@alumni.mondragon.edu','mario.espinosa@alumni.mondragon.edu');
update public.perfiles set rol='visitante', nombre='Shazia' where email='smaryam@mondragon.edu';
