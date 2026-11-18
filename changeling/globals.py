from typing import List, Optional

source_path: Optional[str] = None
target_path: Optional[str] = None
output_path: Optional[str] = None
headless: Optional[bool] = None
frame_processors: List[str] = []
keep_fps: Optional[bool] = None
keep_frames: Optional[bool] = None
skip_audio: Optional[bool] = None
many_faces: Optional[bool] = None
# the Sharper face model: GFPGAN, CodeFormer or GPEN
face_enhancer_model: str = 'GFPGAN'
swap_style: str = 'classic'                 # the swap's look: 'classic' or 'deep-live-cam' (dlc_style.py)
keep_mouth: Optional[int] = None            # Deep-Live-Cam style: keep your own mouth, 0 (the lips) .. 100 (to the chin)
reference_face_position: Optional[int] = None
reference_frame_number: Optional[int] = None
similar_face_distance: Optional[float] = None
temp_frame_format: Optional[str] = None
temp_frame_quality: Optional[int] = None
output_video_encoder: Optional[str] = None
output_video_quality: Optional[int] = None
max_memory: Optional[int] = None
execution_providers: List[str] = []
execution_threads: Optional[int] = None
log_level: str = 'error'
